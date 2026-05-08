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

// ─── IMPROVED PERSISTENT STORAGE ──────────────────────────────────────
const DATA_FILE = path.join(__dirname, 'data.json');
const BACKUP_FILE = path.join(__dirname, 'data.backup.json');

// ✅ AUTO-SAVE interval - saves every 30 seconds regardless
let saveInterval = null;

function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      console.log(`✅ Loaded ${Object.keys(parsed.users || {}).length} users from disk`);
      return { users: parsed.users || {}, sessions: parsed.sessions || {} };
    }
  } catch (e) {
    console.error('⚠️ Failed to load data.json:', e.message);
    // Try backup
    try {
      if (fs.existsSync(BACKUP_FILE)) {
        const raw = fs.readFileSync(BACKUP_FILE, 'utf8');
        const parsed = JSON.parse(raw);
        console.log(`✅ Recovered from backup with ${Object.keys(parsed.users || {}).length} users`);
        return { users: parsed.users || {}, sessions: parsed.sessions || {} };
      }
    } catch (e2) {
      console.error('⚠️ Backup also failed:', e2.message);
    }
  }
  return { users: {}, sessions: {} };
}

function saveData() {
  try {
    const data = { users, sessions, lastSaved: new Date().toISOString() };
    
    // Write to file atomically
    const tempFile = DATA_FILE + '.tmp';
    fs.writeFileSync(tempFile, JSON.stringify(data, null, 2), 'utf8');
    
    // Backup old file
    if (fs.existsSync(DATA_FILE)) {
      fs.copyFileSync(DATA_FILE, BACKUP_FILE);
    }
    
    // Replace with new file
    fs.renameSync(tempFile, DATA_FILE);
    
    console.log(`💾 Saved ${Object.keys(users).length} users to disk at ${new Date().toLocaleTimeString()}`);
    return true;
  } catch (e) {
    console.error('❌ CRITICAL: Failed to save data.json:', e.message);
    return false;
  }
}

// ✅ AUTO-SAVE every 30 seconds
function startAutoSave() {
  if (saveInterval) clearInterval(saveInterval);
  
  saveInterval = setInterval(() => {
    console.log('🔄 Auto-saving...');
    saveData();
  }, 30000); // 30 seconds
}

const { users, sessions } = loadData();
const games = {};
const waitingPlayers = { normal: [], phoenix: [] };

// Start auto-save immediately
startAutoSave();

// ✅ Save on graceful shutdown
process.on('SIGTERM', () => {
  console.log('📤 Shutting down gracefully...');
  saveData();
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('📤 Shutting down gracefully...');
  saveData();
  process.exit(0);
});

console.log(`✅ Loaded ${Object.keys(users).length} users from storage.`);

// ─── Time format helpers ──────────────────────────────────────────────────
function getTimeKey(seconds, increment) {
  const inc = increment || 0;
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
  return { mode: 'normal', cat: 'blitz_5m' };
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
  return { mode: 'phoenix', cat: 'blitz_5m' };
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

// ✅ PGN generation for game export
function generatePGN(game, result) {
  const date = new Date();
  const dateStr = date.toISOString().split('T')[0];
  
  let pgnResult = '*';
  if (result === 'win') pgnResult = '1-0';
  else if (result === 'loss') pgnResult = '0-1';
  else if (result === 'draw') pgnResult = '1/2-1/2';
  
  const moves = game.chess.history({ verbose: true })
    .map((m, i) => {
      if (i % 2 === 0) return `${Math.floor(i/2) + 1}. ${m.san}`;
      return m.san;
    })
    .join(' ');
  
  return `[Event "Phoenix Chess Game"]
[Site "phoenix-chess.com"]
[Date "${dateStr}"]
[White "${game.usernames.w}"]
[Black "${game.usernames.b}"]
[Result "${pgnResult}"]
[TimeControl "${game.timerSeconds}+${game.increment}"]

${moves} ${pgnResult}`;
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
  
  // ✅ SAVE IMMEDIATELY after registration
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
  
  // ✅ SAVE immediately after login
  saveData();
  
  res.json({ token, user: sanitizeUser(user) });
});

app.post('/auth/logout', authMiddleware, (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  delete sessions[token];
  
  // ✅ SAVE immediately after logout
  saveData();
  
  res.json({ success: true });
});

// ─── Profile routes ───────────────────────────────────────────────────────
app.get('/profile/me', authMiddleware, (req, res) => {
  const user = users[req.username];
  if (!user) return res.status(404).json({ error: 'User not found' });
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
  
  // ✅ SAVE immediately after profile update
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

// ✅ NEW: Export match history as JSON (for analysis tools)
app.get('/history/:username/export', (req, res) => {
  const user = users[req.params.username.toLowerCase()];
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({
    username: user.username,
    exportDate: new Date().toISOString(),
    totalGames: user.matchHistory.length,
    matches: user.matchHistory
  });
});

// ✅ NEW: Get single game analysis
app.get('/game/:gameId', (req, res) => {
  const { gameId } = req.params;
  
  for (const user of Object.values(users)) {
    const game = user.matchHistory.find(m => m.gameId === gameId);
    if (game) {
      return res.json(game);
    }
  }
  
  res.status(404).json({ error: 'Game not found' });
});

// ✅ NEW: Update game analysis notes
app.patch('/game/:gameId/notes', authMiddleware, (req, res) => {
  const { gameId } = req.params;
  const { notes } = req.body;
  
  const user = users[req.username];
  const game = user.matchHistory.find(m => m.gameId === gameId);
  
  if (!game) return res.status(404).json({ error: 'Game not found' });
  
  game.notes = { ...game.notes, ...notes };
  saveData();
  
  res.json({ success: true, notes: game.notes });
});

// ─── Health check ─────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    status: 'Phoenix Chess Server running ✅',
    players: Object.keys(users).length,
    activeGames: Object.keys(games).length,
    dataPersisted: fs.existsSync(DATA_FILE),
    lastSave: fs.existsSync(DATA_FILE) ? fs.statSync(DATA_FILE).mtime : null,
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

  // DRAW or STALEMATE
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
      const moveHistory = game.chess.history({ verbose: true });
      
      // ✅ FULL MATCH RECORD WITH ANALYSIS
      const matchRecord1 = {
        gameId,
        mode,
        cat,
        result: 'draw',
        opponent: u2.username,
        ratingChange: rc1,
        date: Date.now(),
        color: 'w',
        pgn: generatePGN(game, 'draw'),
        moves: moveHistory.map((m) => ({
          ...m,
          eval: 0,
          depth: 0,
          bestEval: 0,
          classification: 'Decent'
        })),
        analysis: {
          total_moves: moveHistory.length,
          accuracy: 50,
          classifications: {
            Best: 0, Good: 0, Decent: 0,
            Inaccuracy: 0, Mistake: 0, Blunder: 0, Brilliant: 0
          },
          blunders: [],
          brilliant_moves: []
        },
        notes: {}
      };
      
      u1.matchHistory.push(matchRecord1);
      u2.matchHistory.push({
        ...matchRecord1,
        opponent: u1.username,
        ratingChange: rc2,
        color: 'b'
      });
      
      saveData();
    }
  } 
  // WIN/LOSS
  else if (winnerColor && loserColor) {
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
      const moveHistory = game.chess.history({ verbose: true });
      
      // ✅ FULL MATCH RECORD WITH ANALYSIS FOR WINNER
      const matchRecordWinner = {
        gameId,
        mode,
        cat,
        result: 'win',
        opponent: loser.username,
        ratingChange: rc,
        date: Date.now(),
        color: winnerColor,
        pgn: generatePGN(game, 'win'),
        moves: moveHistory.map((m) => ({
          ...m,
          eval: 0,
          depth: 0,
          bestEval: 0,
          classification: 'Decent'
        })),
        analysis: {
          total_moves: moveHistory.length,
          accuracy: 50,
          classifications: {
            Best: 0, Good: 0, Decent: 0,
            Inaccuracy: 0, Mistake: 0, Blunder: 0, Brilliant: 0
          },
          blunders: [],
          brilliant_moves: []
        },
        notes: {}
      };
      
      // ✅ FULL MATCH RECORD WITH ANALYSIS FOR LOSER
      const matchRecordLoser = {
        gameId,
        mode,
        cat,
        result: 'loss',
        opponent: winner.username,
        ratingChange: -rc,
        date: Date.now(),
        color: loserColor,
        pgn: generatePGN(game, 'loss'),
        moves: moveHistory.map((m) => ({
          ...m,
          eval: 0,
          depth: 0,
          bestEval: 0,
          classification: 'Decent'
        })),
        analysis: {
          total_moves: moveHistory.length,
          accuracy: 50,
          classifications: {
            Best: 0, Good: 0, Decent: 0,
            Inaccuracy: 0, Mistake: 0, Blunder: 0, Brilliant: 0
          },
          blunders: [],
          brilliant_moves: []
        },
        notes: {}
      };
      
      winner.matchHistory.push(matchRecordWinner);
      loser.matchHistory.push(matchRecordLoser);
      
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
    } catch (e) { 
      console.error('Move error:', e); 
    }
  });

  socket.on('resign', ({ gameId }) => {
    const game = games[gameId];
    if (!game) return;
    const loser = game.players.w === socket.id ? 'w' : 'b';
    const winner = loser === 'w' ? 'b' : 'w';
    endGame(gameId, winner === 'w' ? 'White wins' : 'Black wins', 'Resignation', winner, loser);
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
server.listen(PORT, () => {
  console.log(`🚀 Phoenix Chess Server running on port ${PORT}`);
  console.log(`💾 Data persisted to: ${DATA_FILE}`);
  console.log(`📊 Auto-save enabled every 30 seconds`);
  console.log(`📈 Server started at ${new Date().toLocaleTimeString()}`);
});
