const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { Chess } = require('chess.js');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
});

// ─── In-memory storage (replace with database later) ───
const users = {};       // username → user object
const sessions = {};    // token → username
const games = {};
const waitingPlayers = { normal: [], phoenix: [] };

// ─── ELO helpers ───
function getTimeCategory(seconds, increment) {
  const total = seconds + increment * 40;
  if (total < 180) return 'bullet';
  if (total < 600) return 'blitz';
  if (total < 1800) return 'rapid';
  return 'classical';
}

function getTier(rating) {
  if (rating < 800)  return { name: 'Beginner',             emoji: '🌱' };
  if (rating < 1300) return { name: 'Intermediate',         emoji: '⭐' };
  if (rating < 1800) return { name: 'Advanced',             emoji: '⚔️' };
  if (rating < 2000) return { name: 'Master',               emoji: '👑' };
  if (rating < 2300) return { name: 'International Master', emoji: '💎' };
  return                    { name: 'Grandmaster',           emoji: '🔥' };
}

function calcElo(playerRating, opponentRating, result) {
  const K = 32;
  const expected = 1 / (1 + Math.pow(10, (opponentRating - playerRating) / 400));
  return Math.round(playerRating + K * (result - expected));
}

function createUser(username, passwordHash) {
  return {
    username,
    passwordHash,
    displayName: username,
    bio: '',
    country: '',
    createdAt: Date.now(),
    ratings: {
      normal:  { bullet: 400, blitz: 400, rapid: 400, classical: 400 },
      phoenix: { blitz: 400, rapid: 400, classical: 400 },
    },
    peakRatings: {
      normal:  { bullet: 400, blitz: 400, rapid: 400, classical: 400 },
      phoenix: { blitz: 400, rapid: 400, classical: 400 },
    },
    stats: {
      normal:  { wins: 0, losses: 0, draws: 0 },
      phoenix: { wins: 0, losses: 0, draws: 0 },
    },
    matchHistory: [],
    winStreak: 0,
    bestWinStreak: 0,
  };
}

function hashPassword(password) {
  return crypto.createHash('sha256').update(password).digest('hex');
}

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

// ─── Auth middleware ───
function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token || !sessions[token]) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  req.username = sessions[token];
  next();
}

// ─── Auth routes ───
app.post('/auth/register', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  if (username.length < 3 || username.length > 20) return res.status(400).json({ error: 'Username must be 3-20 characters' });
  if (!/^[a-zA-Z0-9_]+$/.test(username)) return res.status(400).json({ error: 'Username can only contain letters, numbers and underscores' });
  if (users[username.toLowerCase()]) return res.status(400).json({ error: 'Username already taken' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

  const user = createUser(username, hashPassword(password));
  users[username.toLowerCase()] = user;

  const token = generateToken();
  sessions[token] = username.toLowerCase();

  res.json({ token, user: sanitizeUser(user) });
});

app.post('/auth/login', (req, res) => {
  const { username, password } = req.body;
  const user = users[username?.toLowerCase()];
  if (!user || user.passwordHash !== hashPassword(password)) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }
  const token = generateToken();
  sessions[token] = username.toLowerCase();
  res.json({ token, user: sanitizeUser(user) });
});

app.post('/auth/logout', authMiddleware, (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  delete sessions[token];
  res.json({ success: true });
});

// ─── Profile routes ───
function sanitizeUser(user) {
  const { passwordHash, ...safe } = user;
  return safe;
}

app.get('/profile/me', authMiddleware, (req, res) => {
  const user = users[req.username];
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json(sanitizeUser(user));
});

app.get('/profile/:username', (req, res) => {
  const user = users[req.params.username.toLowerCase()];
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json(sanitizeUser(user));
});

app.patch('/profile/me', authMiddleware, (req, res) => {
  const user = users[req.username];
  if (!user) return res.status(404).json({ error: 'User not found' });
  const { displayName, bio, country } = req.body;
  if (displayName) user.displayName = displayName.slice(0, 30);
  if (bio !== undefined) user.bio = bio.slice(0, 200);
  if (country !== undefined) user.country = country.slice(0, 50);
  res.json(sanitizeUser(user));
});

// ─── Leaderboard routes ───
app.get('/leaderboard/:mode/:category', (req, res) => {
  const { mode, category } = req.params;
  const validModes = ['normal', 'phoenix'];
  const validCategories = ['bullet', 'blitz', 'rapid', 'classical'];
  if (!validModes.includes(mode)) return res.status(400).json({ error: 'Invalid mode' });
  if (!validCategories.includes(category)) return res.status(400).json({ error: 'Invalid category' });
  if (mode === 'phoenix' && category === 'bullet') return res.status(400).json({ error: 'Phoenix Core has no bullet' });

  const ranked = Object.values(users)
    .filter(u => u.ratings[mode]?.[category] !== undefined)
    .sort((a, b) => (b.ratings[mode][category] || 400) - (a.ratings[mode][category] || 400))
    .slice(0, 50)
    .map((u, i) => ({
      rank: i + 1,
      username: u.username,
      displayName: u.displayName,
      rating: u.ratings[mode][category],
      tier: getTier(u.ratings[mode][category]),
      stats: u.stats[mode],
    }));

  res.json(ranked);
});

// ─── Match history ───
app.get('/history/:username', (req, res) => {
  const user = users[req.params.username.toLowerCase()];
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json(user.matchHistory.slice(-50).reverse());
});

// ─── Health check ───
app.get('/', (req, res) => {
  res.json({
    status: 'Phoenix Chess Server running',
    players: Object.keys(users).length,
    activeGames: Object.keys(games).length,
  });
});

// ─── Socket matchmaking ───
function createGame(socket1, socket2, mode, timerSeconds, increment) {
  const gameId = Math.random().toString(36).substring(2, 8).toUpperCase();
  const chess = new Chess();
  const isP1White = Math.random() > 0.5;

  games[gameId] = {
    id: gameId,
    mode,
    chess,
    timerSeconds,
    increment,
    category: getTimeCategory(timerSeconds, increment),
    players: {
      w: isP1White ? socket1.id : socket2.id,
      b: isP1White ? socket2.id : socket1.id,
    },
    usernames: {
      w: isP1White ? socket1.username : socket2.username,
      b: isP1White ? socket2.username : socket1.username,
    },
    timers: { w: timerSeconds, b: timerSeconds },
    timerInterval: null,
    started: false,
  };

  const colors = {
    [socket1.id]: isP1White ? 'w' : 'b',
    [socket2.id]: isP1White ? 'b' : 'w',
  };

  return { gameId, colors };
}

function startTimer(gameId) {
  const game = games[gameId];
  if (!game) return;
  game.timerInterval = setInterval(() => {
    const turn = game.chess.turn();
    game.timers[turn]--;
    io.to(gameId).emit('timerUpdate', { w: game.timers.w, b: game.timers.b });
    if (game.timers[turn] <= 0) {
      clearInterval(game.timerInterval);
      const winner = turn === 'w' ? 'b' : 'w';
      endGame(gameId, winner === 'w' ? 'White wins' : 'Black wins', 'Time out', winner, turn);
    }
  }, 1000);
}

function endGame(gameId, result, reason, winnerColor, loserColor) {
  const game = games[gameId];
  if (!game) return;
  clearInterval(game.timerInterval);

  io.to(gameId).emit('gameOver', { result, reason });

  // Update ratings if both players are logged in
  const winnerUsername = winnerColor ? game.usernames[winnerColor] : null;
  const loserUsername  = loserColor  ? game.usernames[loserColor]  : null;

  if (reason === 'Draw') {
    const u1 = game.usernames.w ? users[game.usernames.w] : null;
    const u2 = game.usernames.b ? users[game.usernames.b] : null;
    if (u1 && u2) {
      const cat = game.category;
      const mode = game.mode;
      const r1 = u1.ratings[mode][cat];
      const r2 = u2.ratings[mode][cat];
      u1.ratings[mode][cat] = calcElo(r1, r2, 0.5);
      u2.ratings[mode][cat] = calcElo(r2, r1, 0.5);
      u1.peakRatings[mode][cat] = Math.max(u1.peakRatings[mode][cat], u1.ratings[mode][cat]);
      u2.peakRatings[mode][cat] = Math.max(u2.peakRatings[mode][cat], u2.ratings[mode][cat]);
      u1.stats[mode].draws++;
      u2.stats[mode].draws++;
      const record = { gameId, mode, category: cat, result: 'draw', opponent: u2.username, ratingChange: u1.ratings[mode][cat] - r1, date: Date.now() };
      u1.matchHistory.push(record);
      u2.matchHistory.push({ ...record, opponent: u1.username, ratingChange: u2.ratings[mode][cat] - r2 });
    }
  } else if (winnerUsername && loserUsername) {
    const winner = users[winnerUsername];
    const loser  = users[loserUsername];
    if (winner && loser) {
      const cat = game.category;
      const mode = game.mode;
      const wr = winner.ratings[mode][cat];
      const lr = loser.ratings[mode][cat];
      winner.ratings[mode][cat] = calcElo(wr, lr, 1);
      loser.ratings[mode][cat]  = calcElo(lr, wr, 0);
      winner.peakRatings[mode][cat] = Math.max(winner.peakRatings[mode][cat], winner.ratings[mode][cat]);
      winner.stats[mode].wins++;
      loser.stats[mode].losses++;
      winner.winStreak++;
      loser.winStreak = 0;
      winner.bestWinStreak = Math.max(winner.bestWinStreak, winner.winStreak);
      const ratingChange = winner.ratings[mode][cat] - wr;
      winner.matchHistory.push({ gameId, mode, category: cat, result: 'win',  opponent: loser.username,  ratingChange,          date: Date.now() });
      loser.matchHistory.push({  gameId, mode, category: cat, result: 'loss', opponent: winner.username, ratingChange: -(ratingChange), date: Date.now() });
    }
  }

  delete games[gameId];
}

io.on('connection', (socket) => {
  console.log('Connected:', socket.id);

  // Attach username to socket if logged in
  socket.on('authenticate', ({ token }) => {
    const username = sessions[token];
    if (username) {
      socket.username = username;
      socket.emit('authenticated', { username, user: sanitizeUser(users[username]) });
    }
  });

  socket.on('findGame', ({ mode, timerSeconds, increment, token }) => {
    if (token && sessions[token]) socket.username = sessions[token];
    const queue = waitingPlayers[mode] || waitingPlayers.normal;
    if (queue.length > 0) {
      const opponent = queue.shift();
      const { gameId, colors } = createGame(socket, opponent, mode, timerSeconds || 600, increment || 0);
      const game = games[gameId];
      socket.join(gameId);
      opponent.join(gameId);

      const getPlayerInfo = (username) => {
        if (!username) return null;
        const user = users[username];
        if (!user) return null;
        const cat = game.category;
        return { username: user.username, displayName: user.displayName, rating: user.ratings[mode][cat], tier: getTier(user.ratings[mode][cat]) };
      };

      socket.emit('gameFound', {
        gameId, color: colors[socket.id], timers: game.timers,
        opponent: getPlayerInfo(opponent.username),
        category: game.category,
      });
      opponent.emit('gameFound', {
        gameId, color: colors[opponent.id], timers: game.timers,
        opponent: getPlayerInfo(socket.username),
        category: game.category,
      });

      game.started = true;
      startTimer(gameId);
    } else {
      waitingPlayers[mode] = waitingPlayers[mode] || [];
      waitingPlayers[mode].push(socket);
      socket.emit('waiting');
    }
  });

  socket.on('makeMove', ({ gameId, from, to, promotion }) => {
    const game = games[gameId];
    if (!game) return;
    const playerColor = game.players.w === socket.id ? 'w' : 'b';
    if (game.chess.turn() !== playerColor) return;
    try {
      const result = game.chess.move({ from, to, promotion: promotion || 'q' });
      if (!result) return;

      // Add increment
      if (game.increment > 0) game.timers[playerColor] += game.increment;

      const isCheckmate = game.chess.isCheckmate();
      const isDraw = game.chess.isDraw();
      const isCheck = game.chess.inCheck();

      io.to(gameId).emit('moveMade', {
        from: result.from, to: result.to, promotion: result.promotion,
        fen: game.chess.fen(), turn: game.chess.turn(),
        isCheck, isCheckmate, isDraw, captured: result.captured,
        history: game.chess.history({ verbose: true }),
        timers: game.timers,
      });

      if (isCheckmate) {
        const winnerColor = playerColor;
        const loserColor = playerColor === 'w' ? 'b' : 'w';
        endGame(gameId, winnerColor === 'w' ? 'White wins' : 'Black wins', 'Checkmate', winnerColor, loserColor);
      } else if (isDraw) {
        endGame(gameId, 'Draw', 'Draw', null, null);
      }
    } catch (e) { console.error(e); }
  });

  socket.on('resign', ({ gameId }) => {
    const game = games[gameId];
    if (!game) return;
    const loserColor = game.players.w === socket.id ? 'w' : 'b';
    const winnerColor = loserColor === 'w' ? 'b' : 'w';
    endGame(gameId, winnerColor === 'w' ? 'White wins' : 'Black wins', 'Resignation', winnerColor, loserColor);
  });

  socket.on('offerDraw', ({ gameId }) => {
    socket.to(gameId).emit('drawOffered');
  });

  socket.on('respondDraw', ({ gameId, accept }) => {
    if (accept) {
      endGame(gameId, 'Draw', 'Draw agreement', null, null);
    } else {
      socket.to(gameId).emit('drawDeclined');
    }
  });

  socket.on('cancelSearch', () => {
    for (const mode of ['normal', 'phoenix']) {
      waitingPlayers[mode] = (waitingPlayers[mode] || []).filter(s => s.id !== socket.id);
    }
  });

  socket.on('disconnect', () => {
    for (const mode of ['normal', 'phoenix']) {
      waitingPlayers[mode] = (waitingPlayers[mode] || []).filter(s => s.id !== socket.id);
    }
    for (const gameId of Object.keys(games)) {
      const game = games[gameId];
      if (game.players.w === socket.id || game.players.b === socket.id) {
        const loserColor = game.players.w === socket.id ? 'w' : 'b';
        const winnerColor = loserColor === 'w' ? 'b' : 'w';
        endGame(gameId, winnerColor === 'w' ? 'White wins' : 'Black wins', 'Opponent disconnected', winnerColor, loserColor);
        break;
      }
    }
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
