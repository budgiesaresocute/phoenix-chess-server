const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { Chess } = require('chess.js');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
});

// Store active games and queues
const waitingPlayers = {
  normal: [],
  phoenix: [],
};

const games = {};

function createGame(player1, player2, mode) {
  const gameId = Math.random().toString(36).substring(2, 8).toUpperCase();
  const chess = new Chess();

  // Randomly assign colors
  const colors = Math.random() > 0.5
    ? { [player1]: 'w', [player2]: 'b' }
    : { [player1]: 'b', [player2]: 'w' };

  games[gameId] = {
    id: gameId,
    mode,
    chess,
    players: { w: null, b: null },
    sockets: { w: null, b: null },
    timers: { w: 600, b: 600 },
    timerInterval: null,
    started: false,
    resigned: null,
    drawOffer: null,
    phoenixState: mode === 'phoenix' ? {
      positions: { w: 'e1', b: 'e8' },
      active: { w: true, b: true },
      used: { w: false, b: false },
      turnsSinceMoved: { w: 0, b: 0 },
    } : null,
  };

  // Assign colors
  if (colors[player1] === 'w') {
    games[gameId].players.w = player1;
    games[gameId].players.b = player2;
  } else {
    games[gameId].players.w = player2;
    games[gameId].players.b = player1;
  }

  return { gameId, colors };
}

function startTimer(gameId) {
  const game = games[gameId];
  if (!game) return;

  game.timerInterval = setInterval(() => {
    const turn = game.chess.turn();
    game.timers[turn]--;

    io.to(gameId).emit('timerUpdate', {
      w: game.timers.w,
      b: game.timers.b,
    });

    if (game.timers[turn] <= 0) {
      clearInterval(game.timerInterval);
      const winner = turn === 'w' ? 'b' : 'w';
      io.to(gameId).emit('gameOver', {
        result: winner === 'w' ? 'White wins' : 'Black wins',
        reason: 'Time out',
      });
      delete games[gameId];
    }
  }, 1000);
}

io.on('connection', (socket) => {
  console.log('Player connected:', socket.id);

  // Join matchmaking queue
  socket.on('findGame', ({ mode, timerSeconds }) => {
    const queue = waitingPlayers[mode] || waitingPlayers.normal;

    // Check if there's already a player waiting
    if (queue.length > 0) {
      const opponent = queue.shift();

      // Create the game
      const { gameId, colors } = createGame(socket.id, opponent.id, mode);
      const game = games[gameId];

      // Set timer
      game.timers.w = timerSeconds || 600;
      game.timers.b = timerSeconds || 600;

      // Join both players to the game room
      socket.join(gameId);
      opponent.join(gameId);

      game.sockets.w = game.players.w === socket.id ? socket : opponent;
      game.sockets.b = game.players.b === socket.id ? socket : opponent;

      // Tell each player their color and game info
      socket.emit('gameFound', {
        gameId,
        color: colors[socket.id],
        opponentId: opponent.id,
        timers: game.timers,
        phoenixState: game.phoenixState,
      });

      opponent.emit('gameFound', {
        gameId,
        color: colors[opponent.id],
        opponentId: socket.id,
        timers: game.timers,
        phoenixState: game.phoenixState,
      });

      game.started = true;
      startTimer(gameId);

      console.log(`Game ${gameId} started between ${socket.id} and ${opponent.id}`);
    } else {
      // Add to queue
      waitingPlayers[mode] = waitingPlayers[mode] || [];
      waitingPlayers[mode].push(socket);
      socket.emit('waiting', { message: 'Waiting for opponent...' });
      console.log(`Player ${socket.id} waiting for ${mode} game`);
    }
  });

  // Handle a move
  socket.on('makeMove', ({ gameId, from, to, promotion }) => {
    const game = games[gameId];
    if (!game) return;

    // Verify it's this player's turn
    const playerColor = game.players.w === socket.id ? 'w' : 'b';
    if (game.chess.turn() !== playerColor) return;

    try {
      const result = game.chess.move({ from, to, promotion: promotion || 'q' });
      if (!result) return;

      const isCheckmate = game.chess.isCheckmate();
      const isDraw = game.chess.isDraw();
      const isCheck = game.chess.inCheck();

      // Send move to both players
      io.to(gameId).emit('moveMade', {
        from: result.from,
        to: result.to,
        promotion: result.promotion,
        fen: game.chess.fen(),
        turn: game.chess.turn(),
        isCheck,
        isCheckmate,
        isDraw,
        captured: result.captured,
        history: game.chess.history({ verbose: true }),
      });

      if (isCheckmate) {
        clearInterval(game.timerInterval);
        const winner = game.chess.turn() === 'w' ? 'b' : 'w';
        io.to(gameId).emit('gameOver', {
          result: winner === 'w' ? 'White wins' : 'Black wins',
          reason: 'Checkmate',
        });
        delete games[gameId];
      } else if (isDraw) {
        clearInterval(game.timerInterval);
        io.to(gameId).emit('gameOver', {
          result: 'Draw',
          reason: 'Stalemate or draw rule',
        });
        delete games[gameId];
      }
    } catch (e) {
      console.error('Move error:', e);
    }
  });

  // Handle resignation
  socket.on('resign', ({ gameId }) => {
    const game = games[gameId];
    if (!game) return;
    clearInterval(game.timerInterval);
    const loserColor = game.players.w === socket.id ? 'w' : 'b';
    const winner = loserColor === 'w' ? 'Black wins' : 'White wins';
    io.to(gameId).emit('gameOver', {
      result: winner,
      reason: 'Resignation',
    });
    delete games[gameId];
  });

  // Handle draw offer
  socket.on('offerDraw', ({ gameId }) => {
    const game = games[gameId];
    if (!game) return;
    game.drawOffer = socket.id;
    socket.to(gameId).emit('drawOffered');
  });

  // Handle draw response
  socket.on('respondDraw', ({ gameId, accept }) => {
    const game = games[gameId];
    if (!game) return;
    if (accept) {
      clearInterval(game.timerInterval);
      io.to(gameId).emit('gameOver', {
        result: 'Draw',
        reason: 'Draw agreement',
      });
      delete games[gameId];
    } else {
      game.drawOffer = null;
      socket.to(gameId).emit('drawDeclined');
    }
  });

  // Handle disconnect
  socket.on('disconnect', () => {
    console.log('Player disconnected:', socket.id);

    // Remove from waiting queues
    for (const mode of ['normal', 'phoenix']) {
      if (waitingPlayers[mode]) {
        waitingPlayers[mode] = waitingPlayers[mode].filter(s => s.id !== socket.id);
      }
    }

    // Handle active game disconnect
    for (const gameId of Object.keys(games)) {
      const game = games[gameId];
      if (game.players.w === socket.id || game.players.b === socket.id) {
        clearInterval(game.timerInterval);
        const disconnectedColor = game.players.w === socket.id ? 'w' : 'b';
        const winner = disconnectedColor === 'w' ? 'Black wins' : 'White wins';
        io.to(gameId).emit('gameOver', {
          result: winner,
          reason: 'Opponent disconnected',
        });
        delete games[gameId];
        break;
      }
    }
  });
});

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'Phoenix Chess Server running', games: Object.keys(games).length });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
