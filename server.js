const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { Chess } = require('chess.js');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
});

// ─── Persistent storage ───────────────────────────────────────────────────
const DATA_FILE = path.join(__dirname, 'data.json');

function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      return { users: parsed.users || {}, sessions: parsed.sessions || {} };
    }
  } catch (e) {
    console.error('Failed to load data.json:', e.message);
  }
  return { users: {}, sessions: {} };
}

function saveData() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify({ users, sessions }, null, 2), 'utf8');
  } catch (e) {
    console.error('Failed to save data.json:', e.message);
  }
}

const { users, sessions } = loadData();
const games = {};
const waitingPlayers = { normal: [], phoenix: [] };

console.log(`Loaded ${Object.keys(users).length} users from storage.`);

// ─── Time format helpers ──────────────────────────────────────────────────
// Maps timer seconds+increment to a specific rating key
function getTimeKey(seconds, increment) {
  const inc = increment || 0;
  // Normal chess formats
  if (seconds === 30  && inc === 0) return { mode: 'normal', cat: 'bullet_30s' };
  if (seconds === 60  && inc === 0) return { mode: 'normal', cat: 'bullet_1m' };
  if (seconds === 120 && inc === 0) return { mode: 'normal', cat: 'bullet_2m' };
  if (seconds === 120 && inc === 3) return { mode: 'normal', cat: 'bullet_2p3' };
  if (seconds === 180 && inc === 0) return { mode: 'normal', cat: 'blitz_3m' };
  if (seconds === 300 && inc === 0) return { mode: 'normal', cat: 'blitz_5m' };
  if (seconds === 300 && inc === 5) return { mode: 'normal', cat: 'blitz_5p5' };
  if (seconds === 420 && inc === 0) return { mode: 'normal', cat: 'rapid_7m' };
  if (seconds === 600 && inc === 0) return { mode: 'normal', cat: 'rapid_10m' };
  if (seconds === 900 && inc === 0) return { mode: 'normal', cat: 'rapid_15m' };
  if (seconds === 900 && inc === 5) return { mode: 'normal', cat: 'rapid_15p5' };
  if (seconds === 1800 && inc === 0) return { mode: 'normal', cat: 'classical_30m' };
  return { mode: 'normal', cat: 'blitz_5m' }; // default
}

function getPhoenixTimeKey(seconds, increment) {
  const inc = increment || 0;
  if (seconds === 240 && inc === 0) return { mode: 'phoenix', cat: 'blitz_4m' };
  if (seconds === 300 && inc === 0) return { mode: 'phoenix', cat: 'blitz_5m' };
  if (seconds === 300 && inc === 6) return { mode: 'phoenix', cat: 'blitz_5p6' };
  if (seconds === 420 && inc === 0) return { mode: 'phoenix', cat: 'rapid_7m' };
  if (seconds === 600 && inc === 0) return { mode: 'phoenix', cat: 'rapid_10m' };
  if (seconds === 900 && inc === 0) return { mode: 'phoenix', cat: 'rapid_15m' };
  if (seconds === 900 && inc === 5) return { mode: 'phoenix', cat: 'rapid_15p5' };
  if (seconds === 1800 && inc === 0) return { mode: 'phoenix', cat: 'classical_30m' };
  return { mode: 'phoenix', cat: 'blitz_5m' }; // default
}

function getCategory(seconds, increment) {
  const total = seconds + (increment || 0) * 40;
  if (total < 180) return 'bullet';
  if (total < 600) return 'blitz';
  if (total < 1800) return 'rapid';
  return 'classical';
}

function getTier(rating) {
  if (rating < 800)  return { name: 'Beginner',             emoji: '🌱', color: 'green'  };
  if (rating < 1300) return { name: 'Intermediate',         emoji: '⭐', color: 'yellow' };
  if (rating < 1800) return { name: 'Advanced',             emoji: '⚔️', color: 'blue'   };
  if (rating < 2000) return { name: 'Master',               emoji: '👑', color: 'purple' };
  if (rating < 2300) return { name: 'International Master', emoji: '💎', color: 'cyan'   };
  return                    { name: 'Grandmaster',           emoji: '🔥', color: 'orange' };
}

function calcElo(playerRating, opponentRating, result) {
  const K = 32;
  const expected = 1 / (1 + Math.pow(10, (opponentRating - playerRating) / 400));
  return Math.round(playerRating + K * (result - expected));
}

// ─── Default ratings for all time formats ────────────────────────────────
function defaultNormalRatings() {
  return {
    bullet_30s: 400, bullet_1m: 400, bullet_2m: 400, bullet_2p3: 400,
    blitz_3m: 400, blitz_5m: 400, blitz_5p5: 400,
    rapid_7m: 400, rapid_10m: 400, rapid_15m: 400, rapid_15p5: 400,
    classical_30m: 400,
  };
}

function defaultPhoenixRatings() {
  return {
    blitz_4m: 400, blitz_5m: 400, blitz_5p6: 400,
    rapid_7m: 400, rapid_10m: 400, rapid_15m: 400, rapid_15p5: 400,
    classical_30m: 400,
  };
}

function createUser(username, passwordHash, email, phone) {
  return {
    username,
    passwordHash,
    email: email || null,
    phone: phone || null,
    displayName: username,
    bio: '',
    country: '',
    aim: '',
    flair: '',
    profilePic: null,
    createdAt: Date.now(),
    ratings: {
      normal: defaultNormalRatings(),
      phoenix: defaultPhoenixRatings(),
    },
    peakRatings: {
      normal: defaultNormalRatings(),
      phoenix: defaultPhoenixRatings(),
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

function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token || !sessions[token]) return res.status(401).json({ error: 'Unauthorized' });
  req.username = sessions[token];
  next();
}

function sanitizeUser(user) {
  const { passwordHash, ...safe } = user;
  return safe;
}

// ─── Auth routes ──────────────────────────────────────────────────────────
app.post('/auth/register', (req, res) => {
  const { username, password, email, phone } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  if (username.length < 3 || username.length > 20) return res.status(400).json({ error: 'Username must be 3-20 characters' });
  if (!/^[a-zA-Z0-9_]+$/.test(username)) return res.status(400).json({ error: 'Username: letters, numbers, underscores only' });
  if (users[username.toLowerCase()]) return res.status(400).json({ error: 'Username already taken' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  if (email) {
    const emailExists = Object.values(users).some(u => u.email === email.toLowerCase());
    if (emailExists) return res.status(400).json({ error: 'Email already registered' });
  }

  const user = createUser(username, hashPassword(password), email?.toLowerCase(), phone);
  users[username.toLowerCase()] = user;
  const token = generateToken();
  sessions[token] = username.toLowerCase();
  saveData();
  res.json({ token, user: sanitizeUser(user) });
});

app.post('/auth/login', (req, res) => {
  const { username, password } = req.body;
  // Allow login by username, email, or phone
  let user = users[username?.toLowerCase()];
  if (!user) {
    user = Object.values(users).find(u =>
      (u.email && u.email === username?.toLowerCase()) ||
      (u.phone && u.phone === username)
    );
  }
  if (!user || user.passwordHash !== hashPassword(password)) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  const token = generateToken();
  sessions[token] = user.username.toLowerCase();
  saveData();
  res.json({ token, user: sanitizeUser(user) });
});

app.post('/auth/logout', authMiddleware, (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  delete sessions[token];
  saveData();
  res.json({ success: true });
});

// ─── Profile routes ───────────────────────────────────────────────────────
app.get('/profile/me', authMiddleware, (req, res) => {
  const user = users[req.username];
  if (!user) return res.status(404).json({ error: 'User not found' });
  // Make sure old accounts have new rating fields
  if (!user.ratings.normal.bullet_30s) {
    user.ratings.normal = { ...defaultNormalRatings(), ...user.ratings.normal };
    user.peakRatings.normal = { ...defaultNormalRatings(), ...user.peakRatings.normal };
    saveData();
  }
  if (!user.ratings.phoenix.blitz_4m) {
    user.ratings.phoenix = { ...defaultPhoenixRatings(), ...user.ratings.phoenix };
    user.peakRatings.phoenix = { ...defaultPhoenixRatings(), ...user.peakRatings.phoenix };
    saveData();
  }
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
  const { displayName, bio, country, aim, flair, profilePic } = req.body;
  if (displayName !== undefined) user.displayName = displayName.slice(0, 30);
  if (bio !== undefined) user.bio = bio.slice(0, 200);
  if (country !== undefined) user.country = country.slice(0, 50);
  if (aim !== undefined) user.aim = aim.slice(0, 100);
  if (flair !== undefined) user.flair = flair.slice(0, 10);
  if (profilePic !== undefined) user.profilePic = profilePic; // base64 string
  saveData();
  res.json(sanitizeUser(user));
});

// ─── Leaderboard ──────────────────────────────────────────────────────────
app.get('/leaderboard/:mode/:cat', (req, res) => {
  const { mode, cat } = req.params;
  const ranked = Object.values(users)
    .filter(u => u.ratings[mode]?.[cat] !== undefined)
    .sort((a, b) => (b.ratings[mode][cat] || 400) - (a.ratings[mode][cat] || 400))
    .slice(0, 100)
    .map((u, i) => ({
      rank: i + 1,
      username: u.username,
      displayName: u.displayName,
      flair: u.flair,
      country: u.country,
      rating: u.ratings[mode][cat],
      tier: getTier(u.ratings[mode][cat]),
      stats: u.stats[mode],
    }));
  res.json(ranked);
});

// ─── Match history ────────────────────────────────────────────────────────
app.get('/history/:username', (req, res) => {
  const user = users[req.params.username.toLowerCase()];
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json(user.matchHistory.slice(-100).reverse());
});

// ─── Health check ─────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    status: 'Phoenix Chess Server running ✅',
    players: Object.keys(users).length,
    activeGames: Object.keys(games).length,
  });
});

// ─── Matchmaking ──────────────────────────────────────────────────────────
function createGame(socket1, socket2, mode, timerSeconds, increment) {
  const gameId = Math.random().toString(36).substring(2, 8).toUpperCase();
  const chess = new Chess();
  const isP1White = Math.random() > 0.5;

  games[gameId] = {
    id: gameId,
    mode,
    chess,
    timerSeconds,
    increment: increment || 0,
    timeKey: mode === 'phoenix'
      ? getPhoenixTimeKey(timerSeconds, increment)
      : getTimeKey(timerSeconds, increment),
    category: getCategory(timerSeconds, increment),
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

  return {
    gameId,
    colors: {
      [socket1.id]: isP1White ? 'w' : 'b',
      [socket2.id]: isP1White ? 'b' : 'w',
    },
  };
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

  const mode = game.mode;
  const { cat } = game.timeKey;

  if (reason === 'Draw' || (!winnerColor && !loserColor)) {
    const u1 = game.usernames.w ? users[game.usernames.w] : null;
    const u2 = game.usernames.b ? users[game.usernames.b] : null;
    if (u1 && u2) {
      const r1 = u1.ratings[mode][cat] || 400;
      const r2 = u2.ratings[mode][cat] || 400;
      u1.ratings[mode][cat] = calcElo(r1, r2, 0.5);
      u2.ratings[mode][cat] = calcElo(r2, r1, 0.5);
      u1.peakRatings[mode][cat] = Math.max(u1.peakRatings[mode][cat] || 400, u1.ratings[mode][cat]);
      u2.peakRatings[mode][cat] = Math.max(u2.peakRatings[mode][cat] || 400, u2.ratings[mode][cat]);
      u1.stats[mode].draws++;
      u2.stats[mode].draws++;
      const rc1 = u1.ratings[mode][cat] - r1;
      const rc2 = u2.ratings[mode][cat] - r2;
      u1.matchHistory.push({ gameId, mode, cat, result: 'draw', opponent: u2.username, ratingChange: rc1, date: Date.now() });
      u2.matchHistory.push({ gameId, mode, cat, result: 'draw', opponent: u1.username, ratingChange: rc2, date: Date.now() });
      saveData();
    }
  } else if (winnerColor && loserColor) {
    const winUN = game.usernames[winnerColor];
    const losUN = game.usernames[loserColor];
    const winner = winUN ? users[winUN] : null;
    const loser  = losUN ? users[losUN] : null;
    if (winner && loser) {
      const wr = winner.ratings[mode][cat] || 400;
      const lr = loser.ratings[mode][cat]  || 400;
      winner.ratings[mode][cat] = calcElo(wr, lr, 1);
      loser.ratings[mode][cat]  = calcElo(lr, wr, 0);
      winner.peakRatings[mode][cat] = Math.max(winner.peakRatings[mode][cat] || 400, winner.ratings[mode][cat]);
      winner.stats[mode].wins++;
      loser.stats[mode].losses++;
      winner.winStreak = (winner.winStreak || 0) + 1;
      loser.winStreak = 0;
      winner.bestWinStreak = Math.max(winner.bestWinStreak || 0, winner.winStreak);
      const rc = winner.ratings[mode][cat] - wr;
      winner.matchHistory.push({ gameId, mode, cat, result: 'win',  opponent: loser.username,  ratingChange: rc,   date: Date.now() });
      loser.matchHistory.push({  gameId, mode, cat, result: 'loss', opponent: winner.username, ratingChange: -rc,  date: Date.now() });
      saveData();
    }
  }

  delete games[gameId];
}

// ─── Socket.io ────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log('Connected:', socket.id);

  socket.on('authenticate', ({ token }) => {
    const username = sessions[token];
    if (username && users[username]) {
      socket.username = username;
      socket.emit('authenticated', { username, user: sanitizeUser(users[username]) });
    }
  });

  socket.on('findGame', ({ mode, timerSeconds, increment, token }) => {
    if (token && sessions[token]) socket.username = sessions[token];
    const modeKey = mode === 'phoenix' ? 'phoenix' : 'normal';
    const queue = waitingPlayers[modeKey];

    if (queue.length > 0) {
      const opponent = queue.shift();
      const { gameId, colors } = createGame(socket, opponent, modeKey, timerSeconds || 600, increment || 0);
      const game = games[gameId];
      socket.join(gameId);
      opponent.join(gameId);

      const getInfo = (un) => {
        if (!un || !users[un]) return null;
        const u = users[un];
        const { cat } = game.timeKey;
        return {
          username: u.username,
          displayName: u.displayName,
          flair: u.flair,
          rating: u.ratings[modeKey][cat] || 400,
          tier: getTier(u.ratings[modeKey][cat] || 400),
        };
      };

      socket.emit('gameFound', {
        gameId, color: colors[socket.id], timers: game.timers,
        opponent: getInfo(opponent.username), category: game.category,
      });
      opponent.emit('gameFound', {
        gameId, color: colors[opponent.id], timers: game.timers,
        opponent: getInfo(socket.username), category: game.category,
      });

      game.started = true;
      startTimer(gameId);
    } else {
      waitingPlayers[modeKey].push(socket);
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
      if (game.increment > 0) game.timers[playerColor] += game.increment;
      const isCheckmate = game.chess.isCheckmate();
      const isDraw = game.chess.isDraw();
      io.to(gameId).emit('moveMade', {
        from: result.from, to: result.to, promotion: result.promotion,
        fen: game.chess.fen(), turn: game.chess.turn(),
        isCheck: game.chess.inCheck(), isCheckmate, isDraw,
        captured: result.captured,
        history: game.chess.history({ verbose: true }),
        timers: game.timers,
      });
      if (isCheckmate) {
        endGame(gameId, playerColor === 'w' ? 'White wins' : 'Black wins', 'Checkmate', playerColor, playerColor === 'w' ? 'b' : 'w');
      } else if (isDraw) {
        endGame(gameId, 'Draw', 'Draw', null, null);
      }
    } catch (e) { console.error(e); }
  });

  socket.on('resign', ({ gameId }) => {
    const game = games[gameId];
    if (!game) return;
    const loser = game.players.w === socket.id ? 'w' : 'b';
    const winner = loser === 'w' ? 'b' : 'w';
    endGame(gameId, winner === 'w' ? 'White wins' : 'Black wins', 'Resignation', winner, loser);
  });

  socket.on('offerDraw', ({ gameId }) => socket.to(gameId).emit('drawOffered'));

  socket.on('respondDraw', ({ gameId, accept }) => {
    if (accept) endGame(gameId, 'Draw', 'Draw agreement', null, null);
    else socket.to(gameId).emit('drawDeclined');
  });

  socket.on('cancelSearch', () => {
    for (const m of ['normal', 'phoenix']) {
      waitingPlayers[m] = waitingPlayers[m].filter(s => s.id !== socket.id);
    }
  });

  socket.on('disconnect', () => {
    for (const m of ['normal', 'phoenix']) {
      waitingPlayers[m] = waitingPlayers[m].filter(s => s.id !== socket.id);
    }
    for (const gameId of Object.keys(games)) {
      const game = games[gameId];
      if (game.players.w === socket.id || game.players.b === socket.id) {
        const loser = game.players.w === socket.id ? 'w' : 'b';
        const winner = loser === 'w' ? 'b' : 'w';
        endGame(gameId, winner === 'w' ? 'White wins' : 'Black wins', 'Opponent disconnected', winner, loser);
        break;
      }
    }
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
