const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";
const PUBLIC_DIR = process.env.PUBLIC_DIR || path.join(__dirname, "../web/public");
const DATA_DIR = path.join(__dirname, "data");
const AUTH_FILE = path.join(DATA_DIR, "beta-auth.json");
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30;
const TICK_MS = 1000 / 60;
const BROADCAST_MS = 1000 / 10;
const GRID_W = 15;
const GRID_H = 13;
const STARTS = [
  { x: 1, y: 1 },
  { x: GRID_W - 2, y: 1 },
  { x: 1, y: GRID_H - 2 },
  { x: GRID_W - 2, y: GRID_H - 2 }
];
const COLORS = ["#31e8ff", "#ff3cac", "#72ff72", "#ff9f1c"];
const SYMBOLS = ["circle", "triangle", "cross", "diamond"];
const POWERUPS = ["bombs", "flames", "speed"];
const MODES = new Set(["friendly", "hardcore"]);
const DIFFICULTIES = new Set(["easy", "normal", "hard"]);
const loginAttempts = new Map();
const authStore = createAuthStore();

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml"
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname.startsWith("/api/")) {
    handleApi(req, res, url);
    return;
  }

  if (url.pathname === "/health") {
    const payload = JSON.stringify({
      ok: true,
      service: "math-bomber-arena",
      phase: game.phase,
      clients: clients.size,
      players: game.players.size,
      uptime: Math.round(process.uptime())
    });
    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    });
    res.end(payload);
    return;
  }

  const safePath = path.normalize(url.pathname).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(PUBLIC_DIR, safePath === "/" ? "index.html" : safePath);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream" });
    res.end(data);
  });
});

const clients = new Map();
let nextPlayerId = 1;
let lobbyDeadline = null;
let readyDeadline = null;
let lastBroadcast = 0;
let mapVersion = 1;

const game = {
  phase: "lobby",
  map: createMap(),
  players: new Map(),
  bombs: [],
  explosions: [],
  powerups: [],
  mathTokens: [],
  mode: "friendly",
  difficulty: "easy",
  winner: null,
  resultsRecorded: false,
  startedAt: 0
};

server.on("upgrade", (req, socket) => {
  if (req.headers.upgrade?.toLowerCase() !== "websocket") {
    socket.destroy();
    return;
  }

  const key = req.headers["sec-websocket-key"];
  const accept = crypto
    .createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");

  socket.write([
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Accept: ${accept}`,
    "",
    ""
  ].join("\r\n"));

  const client = {
    id: crypto.randomUUID(),
    socket,
    playerId: null,
    nickname: "",
    input: { up: false, down: false, left: false, right: false, bomb: false },
    mapVersion: 0,
    frameBuffer: Buffer.alloc(0)
  };
  clients.set(client.id, client);

  socket.on("data", chunk => {
    for (const message of decodeFrames(client, chunk)) handleMessage(client, message);
  });
  socket.on("close", () => disconnect(client));
  socket.on("error", () => disconnect(client));
  send(client, { type: "hello", id: client.id });
  broadcastState(true);
});

async function handleMessage(client, raw) {
  let message;
  try {
    message = JSON.parse(raw);
  } catch {
    return;
  }

  if (message.type === "join") {
    const session = await validateToken(String(message.token || ""));
    if (!session) {
      send(client, { type: "error", code: "auth_required", text: "Login required." });
      return;
    }
    client.account = session.player;
    joinGame(client, session.player.displayName, normalizeMode(message.mode), normalizeDifficulty(message.difficulty));
  } else if (message.type === "input") {
    client.input = { ...client.input, ...message.input };
  } else if (message.type === "mathAnswer" && client.playerId) {
    submitMathAnswer(client.playerId, message.answer);
  } else if (message.type === "chat" && client.playerId) {
    const player = game.players.get(client.playerId);
    broadcast({
      type: "chat",
      from: player?.nickname || client.nickname || "Spectator",
      color: player?.color || "#9296b8",
      text: String(message.text || "").slice(0, 180),
      at: Date.now()
    });
  } else if (message.type === "restart" && ["ended", "lobby"].includes(game.phase)) {
    resetGame();
    broadcastState(true);
  } else if (message.type === "leave" && client.playerId) {
    leaveGame(client);
  }
}

function joinGame(client, nickname, mode, difficulty) {
  if (client.playerId || game.phase !== "lobby" || game.players.size >= 4) return;
  if (game.players.size === 0) {
    game.mode = mode;
    game.difficulty = difficulty;
  }

  const id = nextPlayerId++;
  const slot = getOpenSlot();
  const start = STARTS[slot];
  const player = {
    id,
    nickname,
    color: COLORS[slot],
    symbol: SYMBOLS[slot],
    x: start.x + 0.5,
    y: start.y + 0.5,
    spawn: start,
    lives: 3,
    alive: true,
    invulnerableUntil: Date.now() + 2200,
    bombsMax: 1,
    flameRange: 2,
    speed: 3.6,
    placedBombs: 0,
    score: 0,
    challenge: null,
    mathSolved: 0,
    accountId: client.account?.id || null
  };
  game.players.set(id, player);
  client.playerId = id;
  client.nickname = nickname;
  send(client, { type: "joined", playerId: id });
  broadcast({ type: "system", text: `${nickname} joined the arena.` });
  updateLobbyTimers();
  broadcastState(true);
}

function getOpenSlot() {
  const used = new Set([...game.players.values()].map(player => `${player.spawn.x},${player.spawn.y}`));
  const index = STARTS.findIndex(start => !used.has(`${start.x},${start.y}`));
  return index === -1 ? game.players.size : index;
}

function updateLobbyTimers() {
  const now = Date.now();
  const count = game.players.size;
  if (!lobbyDeadline && count > 0) lobbyDeadline = now + 20000;
  if (count >= 4 && !readyDeadline) readyDeadline = now + 10000;
}

function resetGame() {
  game.phase = "lobby";
  game.map = createMap();
  mapVersion++;
  game.players.clear();
  game.bombs = [];
  game.explosions = [];
  game.powerups = [];
  game.mathTokens = [];
  game.mode = "friendly";
  game.difficulty = "easy";
  game.winner = null;
  game.resultsRecorded = false;
  game.startedAt = 0;
  nextPlayerId = 1;
  lobbyDeadline = null;
  readyDeadline = null;
  for (const client of clients.values()) {
    client.playerId = null;
    client.input = { up: false, down: false, left: false, right: false, bomb: false };
  }
}

function startGame() {
  game.phase = "playing";
  game.startedAt = Date.now();
  game.map = createMap();
  mapVersion++;
  game.bombs = [];
  game.explosions = [];
  game.powerups = [];
  game.mathTokens = [];
  game.resultsRecorded = false;
  for (const [index, player] of [...game.players.values()].entries()) {
    const start = STARTS[index];
    Object.assign(player, {
      x: start.x + 0.5,
      y: start.y + 0.5,
      spawn: start,
      lives: 3,
      alive: true,
      invulnerableUntil: Date.now() + 2200,
      bombsMax: 1,
      flameRange: 2,
      speed: 3.6,
      placedBombs: 0,
      challenge: null
    });
  }
  broadcast({ type: "system", text: `Battle started in ${game.mode} mode on ${game.difficulty} math.` });
}

function createMap() {
  const cells = Array.from({ length: GRID_H }, (_, y) =>
    Array.from({ length: GRID_W }, (_, x) => {
      if (x === 0 || y === 0 || x === GRID_W - 1 || y === GRID_H - 1) return "wall";
      if (x % 2 === 0 && y % 2 === 0) return "wall";
      return "empty";
    })
  );

  const safe = new Set();
  for (const s of STARTS) {
    [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]].forEach(([dx, dy]) => safe.add(`${s.x + dx},${s.y + dy}`));
  }

  for (let y = 1; y < GRID_H - 1; y++) {
    for (let x = 1; x < GRID_W - 1; x++) {
      if (cells[y][x] === "empty" && !safe.has(`${x},${y}`) && Math.random() < 0.52) cells[y][x] = "block";
    }
  }
  return cells;
}

function loop() {
  const now = Date.now();
  if (game.phase === "lobby") {
    const count = game.players.size;
    if (count >= 2 && lobbyDeadline && now >= lobbyDeadline && !readyDeadline) readyDeadline = now + 10000;
    if (count >= 4 && !readyDeadline) readyDeadline = now + 10000;
    if (readyDeadline && now >= readyDeadline && count >= 2) startGame();
  } else if (game.phase === "playing") {
    updatePlayers(TICK_MS / 1000, now);
    updateBombs(now);
    updateExplosions(now);
    checkWinner();
  }

  if (now - lastBroadcast >= BROADCAST_MS) {
    broadcastState(false);
    lastBroadcast = now;
  }
}

function updatePlayers(dt, now) {
  for (const client of clients.values()) {
    const player = game.players.get(client.playerId);
    if (!player?.alive) continue;
    if (player.challenge) {
      client.input = { up: false, down: false, left: false, right: false, bomb: false };
      continue;
    }

    let dx = Number(client.input.right) - Number(client.input.left);
    let dy = Number(client.input.down) - Number(client.input.up);
    if (dx && dy) {
      dx *= Math.SQRT1_2;
      dy *= Math.SQRT1_2;
    }

    movePlayer(player, dx * player.speed * dt, 0);
    movePlayer(player, 0, dy * player.speed * dt);

    if (client.input.bomb) {
      placeBomb(player, now);
      client.input.bomb = false;
    }
    collectPowerup(player);
    collectMathToken(player);
  }
}

function movePlayer(player, dx, dy) {
  const nx = player.x + dx;
  const ny = player.y + dy;
  const radius = 0.32;
  const corners = [
    [nx - radius, ny - radius],
    [nx + radius, ny - radius],
    [nx - radius, ny + radius],
    [nx + radius, ny + radius]
  ];
  if (corners.every(([x, y]) => isWalkable(Math.floor(x), Math.floor(y), player))) {
    player.x = nx;
    player.y = ny;
  }
}

function isWalkable(x, y, player) {
  if (!game.map[y] || game.map[y][x] !== "empty") return false;
  return !game.bombs.some(b => b.x === x && b.y === y && b.ownerId !== player.id);
}

function placeBomb(player, now) {
  const x = Math.floor(player.x);
  const y = Math.floor(player.y);
  if (player.placedBombs >= player.bombsMax || game.bombs.some(b => b.x === x && b.y === y)) return;
  game.bombs.push({ id: crypto.randomUUID(), ownerId: player.id, x, y, range: player.flameRange, explodesAt: now + 2200 });
  player.placedBombs++;
}

function updateBombs(now) {
  const exploding = game.bombs.filter(b => b.explodesAt <= now);
  for (const bomb of exploding) explodeBomb(bomb, now);
  game.bombs = game.bombs.filter(b => b.explodesAt > now);
}

function explodeBomb(bomb, now) {
  const owner = game.players.get(bomb.ownerId);
  if (owner) owner.placedBombs = Math.max(0, owner.placedBombs - 1);
  const cells = [{ x: bomb.x, y: bomb.y }];
  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];

  for (const [dx, dy] of dirs) {
    for (let step = 1; step <= bomb.range; step++) {
      const x = bomb.x + dx * step;
      const y = bomb.y + dy * step;
      const cell = game.map[y]?.[x];
      if (!cell || cell === "wall") break;
      cells.push({ x, y });
      if (cell === "block") {
        game.map[y][x] = "empty";
        mapVersion++;
        maybeSpawnPowerup(x, y);
        if (owner) owner.score++;
        break;
      }
    }
  }

  for (const other of game.bombs) {
    if (other.id !== bomb.id && cells.some(c => c.x === other.x && c.y === other.y)) other.explodesAt = now;
  }
  game.explosions.push({ id: crypto.randomUUID(), cells, until: now + 520 });
  damagePlayers(cells, now);
}

function maybeSpawnPowerup(x, y) {
  const roll = Math.random();
  if (roll < 0.38) {
    game.mathTokens.push({ id: crypto.randomUUID(), x, y });
    return;
  }
  if (roll > 0.56) return;
  game.powerups.push({ id: crypto.randomUUID(), type: POWERUPS[Math.floor(Math.random() * POWERUPS.length)], x, y });
}

function damagePlayers(cells, now) {
  for (const player of game.players.values()) {
    if (!player.alive || player.invulnerableUntil > now) continue;
    if (game.mode === "friendly" && player.challenge) continue;
    const px = Math.floor(player.x);
    const py = Math.floor(player.y);
    if (!cells.some(c => c.x === px && c.y === py)) continue;
    player.lives--;
    if (player.lives <= 0) {
      player.alive = false;
      broadcast({ type: "system", text: `${player.nickname} is out.` });
    } else {
      player.x = player.spawn.x + 0.5;
      player.y = player.spawn.y + 0.5;
      player.invulnerableUntil = now + 1800;
      broadcast({ type: "system", text: `${player.nickname} lost a life.` });
    }
  }
}

function updateExplosions(now) {
  game.explosions = game.explosions.filter(e => e.until > now);
}

function collectPowerup(player) {
  const px = Math.floor(player.x);
  const py = Math.floor(player.y);
  const index = game.powerups.findIndex(p => p.x === px && p.y === py);
  if (index === -1) return;
  const [powerup] = game.powerups.splice(index, 1);
  if (powerup.type === "bombs") player.bombsMax++;
  if (powerup.type === "flames") player.flameRange++;
  if (powerup.type === "speed") player.speed = Math.min(6.2, player.speed + 0.45);
}

function collectMathToken(player) {
  if (player.challenge) return;
  const px = Math.floor(player.x);
  const py = Math.floor(player.y);
  const index = game.mathTokens.findIndex(token => token.x === px && token.y === py);
  if (index === -1) return;
  game.mathTokens.splice(index, 1);
  player.challenge = createMathChallenge(game.difficulty);
  if (game.mode === "friendly") player.invulnerableUntil = Math.max(player.invulnerableUntil, Date.now() + 30000);
}

function submitMathAnswer(playerId, answer) {
  const player = game.players.get(playerId);
  if (!player?.challenge) return;
  const submitted = Number.parseInt(String(answer ?? ""), 10);
  const correct = Number.isFinite(submitted) && submitted === player.challenge.answer;
  if (correct) {
    player.score += 5;
    player.mathSolved++;
    broadcast({ type: "system", text: `${player.nickname} solved ${player.challenge.prompt}.` });
  }
  player.challenge = null;
  if (game.mode === "friendly") player.invulnerableUntil = Date.now() + 900;
}

function createMathChallenge(difficulty) {
  const division = (maxA, maxB) => {
    const answer = rand(2, maxB);
    const divisor = rand(2, maxA);
    return { a: answer * divisor, op: "/", b: divisor, answer };
  };
  const specs = {
    easy: () => {
      const op = Math.random() < 0.5 ? "+" : "-";
      const a = rand(1, 20);
      const b = rand(1, 20);
      return op === "+" ? { a, op, b, answer: a + b } : { a: Math.max(a, b), op, b: Math.min(a, b), answer: Math.abs(a - b) };
    },
    normal: () => {
      const op = ["+", "-", "*", "/"][rand(0, 3)];
      if (op === "*") return { a: rand(4, 12), op, b: rand(3, 12), answer: 0 };
      if (op === "/") return division(12, 12);
      const a = rand(18, 60);
      const b = rand(12, 45);
      return op === "+" ? { a, op, b, answer: a + b } : { a: Math.max(a, b), op, b: Math.min(a, b), answer: Math.abs(a - b) };
    },
    hard: () => {
      const op = ["+", "-", "*", "/"][rand(0, 3)];
      if (op === "*") return { a: rand(12, 19), op, b: rand(7, 16), answer: 0 };
      if (op === "/") return division(16, 18);
      const a = rand(72, 180);
      const b = rand(38, 125);
      return op === "+" ? { a, op, b, answer: a + b } : { a: Math.max(a, b), op, b: Math.min(a, b), answer: Math.abs(a - b) };
    }
  };
  const problem = specs[difficulty]?.() || specs.easy();
  if (problem.op === "*") problem.answer = problem.a * problem.b;
  return {
    id: crypto.randomUUID(),
    prompt: `${problem.a} ${problem.op} ${problem.b}`,
    answer: problem.answer,
    startedAt: Date.now()
  };
}

function rand(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function checkWinner() {
  const alive = [...game.players.values()].filter(p => p.alive);
  if (alive.length <= 1 && game.players.size >= 2) {
    game.phase = "ended";
    game.winner = alive[0] || null;
    broadcast({ type: "system", text: game.winner ? `${game.winner.nickname} wins!` : "Nobody survived." });
    recordMatchResults().catch(() => {});
  }
}

function leaveGame(client) {
  const player = game.players.get(client.playerId);
  if (!player) return;
  if (game.phase === "lobby") {
    game.players.delete(player.id);
    if (game.players.size === 0) {
      lobbyDeadline = null;
      readyDeadline = null;
    } else if (game.players.size < 4) {
      readyDeadline = null;
    }
  } else {
    player.alive = false;
    player.lives = 0;
    player.challenge = null;
    checkWinner();
  }
  client.playerId = null;
  client.input = { up: false, down: false, left: false, right: false, bomb: false };
  send(client, { type: "left" });
  broadcast({ type: "system", text: `${player.nickname} left the arena.` });
  broadcastState(true);
}

function disconnect(client) {
  if (!clients.has(client.id)) return;
  clients.delete(client.id);
  const player = game.players.get(client.playerId);
  if (player) {
    if (game.phase === "lobby") {
      game.players.delete(player.id);
      if (game.players.size === 0) {
        lobbyDeadline = null;
        readyDeadline = null;
      } else if (game.players.size < 4) {
        readyDeadline = null;
      }
    } else {
      player.alive = false;
      player.lives = 0;
    }
    broadcast({ type: "system", text: `${player.nickname} disconnected.` });
  }
  broadcastState(true);
}

async function handleApi(req, res, url) {
  if (req.method === "OPTIONS") {
    sendJson(res, 204, null);
    return;
  }

  try {
    if (req.method === "POST" && url.pathname === "/api/register") {
      const body = await readJson(req);
      const ip = req.socket.remoteAddress || "unknown";
      if (tooManyAttempts(`register:${ip}`)) return sendJson(res, 429, { ok: false, error: "Too many attempts. Try again soon." });
      const result = await registerPlayer(body);
      return sendJson(res, result.status, result.payload);
    }

    if (req.method === "POST" && url.pathname === "/api/login") {
      const body = await readJson(req);
      const key = `login:${req.socket.remoteAddress || "unknown"}:${normalizeName(body.nickname)}`;
      if (tooManyAttempts(key)) return sendJson(res, 429, { ok: false, error: "Too many attempts. Try again soon." });
      const result = await loginPlayer(body);
      return sendJson(res, result.status, result.payload);
    }

    if (req.method === "GET" && url.pathname === "/api/me") {
      const session = await validateToken(readBearer(req));
      if (!session) return sendJson(res, 401, { ok: false, error: "Login required." });
      return sendJson(res, 200, { ok: true, player: publicPlayer(session.player) });
    }

    if (req.method === "GET" && url.pathname === "/api/leaderboard") {
      const leaders = await authStore.getLeaderboard(10);
      return sendJson(res, 200, { ok: true, leaders });
    }

    sendJson(res, 404, { ok: false, error: "Not found" });
  } catch {
    sendJson(res, 400, { ok: false, error: "Invalid request." });
  }
}

async function registerPlayer(body) {
  const nickname = cleanNickname(body.nickname);
  const pin = String(body.pin || "");
  if (!nickname) return result(400, "Nickname is required.");
  if (!/^\d{4}$/.test(pin)) return result(400, "PIN must be exactly 4 digits.");
  if (await authStore.findPlayer(normalizeName(nickname))) return result(409, "Nickname is already taken.");

  const salt = crypto.randomBytes(16).toString("base64url");
  const player = {
    id: crypto.randomUUID(),
    displayName: nickname,
    normalizedName: normalizeName(nickname),
    pinSalt: salt,
    pinHash: hashPin(pin, salt),
    createdAt: new Date().toISOString(),
    lastLoginAt: null
  };
  await authStore.upsertPlayer(player);
  return createSessionResponse(player, 201);
}

async function loginPlayer(body) {
  const nickname = cleanNickname(body.nickname);
  const pin = String(body.pin || "");
  if (!nickname || !/^\d{4}$/.test(pin)) return result(400, "Enter nickname and 4-digit PIN.");
  const player = await authStore.findPlayer(normalizeName(nickname));
  if (!player || hashPin(pin, player.pinSalt) !== player.pinHash) return result(401, "Wrong nickname or PIN.");
  return createSessionResponse(player, 200);
}

async function createSessionResponse(player, status) {
  const token = crypto.randomBytes(32).toString("base64url");
  const now = Date.now();
  player.lastLoginAt = new Date(now).toISOString();
  await authStore.upsertPlayer(player);
  await authStore.addSession({
    id: crypto.randomUUID(),
    playerId: player.id,
    tokenHash: hashToken(token),
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + SESSION_TTL_MS).toISOString(),
    revokedAt: null
  });
  return {
    status,
    payload: {
      ok: true,
      token,
      player: publicPlayer(player),
      expiresAt: new Date(now + SESSION_TTL_MS).toISOString()
    }
  };
}

async function validateToken(token) {
  if (!token) return null;
  const session = await authStore.findSession(hashToken(token));
  if (!session || session.revokedAt || Date.parse(session.expiresAt) <= Date.now()) return null;
  const player = await authStore.findPlayerById(session.playerId);
  if (!player) return null;
  return { session, player };
}

function createAuthStore() {
  if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) return createSupabaseAuthStore();
  const state = readAuthState();
  return {
    async findPlayer(normalizedName) {
      return state.players.find(player => player.normalizedName === normalizedName) || null;
    },
    async findPlayerById(id) {
      return state.players.find(player => player.id === id) || null;
    },
    async upsertPlayer(player) {
      const index = state.players.findIndex(existing => existing.id === player.id);
      if (index === -1) state.players.push(player);
      else state.players[index] = player;
      writeAuthState(state);
    },
    async addSession(session) {
      state.sessions = state.sessions.filter(existing => Date.parse(existing.expiresAt) > Date.now() && !existing.revokedAt);
      state.sessions.push(session);
      writeAuthState(state);
    },
    async findSession(tokenHash) {
      return state.sessions.find(session => session.tokenHash === tokenHash) || null;
    },
    async recordMatch(entries) {
      state.leaderboard ||= [];
      for (const entry of entries) {
        const existing = state.leaderboard.find(row => row.playerId === entry.playerId);
        if (existing) {
          existing.displayName = entry.displayName;
          existing.totalScore += entry.score;
          existing.gamesPlayed += 1;
          existing.wins += entry.won ? 1 : 0;
          existing.mathSolved += entry.mathSolved;
          existing.bestScore = Math.max(existing.bestScore, entry.score);
          existing.updatedAt = new Date().toISOString();
        } else {
          state.leaderboard.push({
            playerId: entry.playerId,
            displayName: entry.displayName,
            totalScore: entry.score,
            gamesPlayed: 1,
            wins: entry.won ? 1 : 0,
            mathSolved: entry.mathSolved,
            bestScore: entry.score,
            updatedAt: new Date().toISOString()
          });
        }
      }
      writeAuthState(state);
    },
    async getLeaderboard(limit = 10) {
      return formatLeaderboard(state.leaderboard || [], limit);
    }
  };
}

function createSupabaseAuthStore() {
  return {
    async findPlayer(normalizedName) {
      const rows = await supabaseSelect("beta_players", `normalized_name=eq.${encodeURIComponent(normalizedName)}&limit=1`);
      return rows[0] ? fromSupabasePlayer(rows[0]) : null;
    },
    async findPlayerById(id) {
      const rows = await supabaseSelect("beta_players", `id=eq.${encodeURIComponent(id)}&limit=1`);
      return rows[0] ? fromSupabasePlayer(rows[0]) : null;
    },
    async upsertPlayer(player) {
      await supabaseRequest("beta_players?on_conflict=id", {
        method: "POST",
        headers: { Prefer: "resolution=merge-duplicates" },
        body: JSON.stringify([toSupabasePlayer(player)])
      });
    },
    async addSession(session) {
      await supabaseRequest("beta_sessions", {
        method: "POST",
        body: JSON.stringify([toSupabaseSession(session)])
      });
    },
    async findSession(tokenHash) {
      const rows = await supabaseSelect("beta_sessions", `token_hash=eq.${encodeURIComponent(tokenHash)}&limit=1`);
      return rows[0] ? fromSupabaseSession(rows[0]) : null;
    },
    async recordMatch(entries) {
      for (const entry of entries) {
        const existing = await supabaseSelect("beta_leaderboard", `player_id=eq.${encodeURIComponent(entry.playerId)}&limit=1`);
        const current = existing[0] || {
          player_id: entry.playerId,
          display_name: entry.displayName,
          total_score: 0,
          games_played: 0,
          wins: 0,
          math_solved: 0,
          best_score: 0
        };
        await supabaseRequest("beta_leaderboard?on_conflict=player_id", {
          method: "POST",
          headers: { Prefer: "resolution=merge-duplicates" },
          body: JSON.stringify([{
            player_id: entry.playerId,
            display_name: entry.displayName,
            total_score: current.total_score + entry.score,
            games_played: current.games_played + 1,
            wins: current.wins + (entry.won ? 1 : 0),
            math_solved: current.math_solved + entry.mathSolved,
            best_score: Math.max(current.best_score, entry.score),
            updated_at: new Date().toISOString()
          }])
        });
      }
    },
    async getLeaderboard(limit = 10) {
      const rows = await supabaseSelect("beta_leaderboard", `order=total_score.desc,wins.desc,games_played.asc&limit=${limit}`);
      return rows.map((row, index) => ({
        rank: index + 1,
        playerId: row.player_id,
        displayName: row.display_name,
        totalScore: row.total_score,
        gamesPlayed: row.games_played,
        wins: row.wins,
        mathSolved: row.math_solved,
        bestScore: row.best_score
      }));
    }
  };
}

async function supabaseSelect(table, query) {
  return supabaseRequest(`${table}?select=*&${query}`, { method: "GET" });
}

async function supabaseRequest(pathname, options = {}) {
  const base = process.env.SUPABASE_URL.replace(/\/$/, "");
  const response = await fetch(`${base}/rest/v1/${pathname}`, {
    ...options,
    headers: {
      apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });
  if (!response.ok) throw new Error(`Supabase request failed: ${response.status}`);
  if (response.status === 204) return null;
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

function toSupabasePlayer(player) {
  return {
    id: player.id,
    display_name: player.displayName,
    normalized_name: player.normalizedName,
    pin_salt: player.pinSalt,
    pin_hash: player.pinHash,
    created_at: player.createdAt,
    last_login_at: player.lastLoginAt
  };
}

function fromSupabasePlayer(row) {
  return {
    id: row.id,
    displayName: row.display_name,
    normalizedName: row.normalized_name,
    pinSalt: row.pin_salt,
    pinHash: row.pin_hash,
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at
  };
}

function toSupabaseSession(session) {
  return {
    id: session.id,
    player_id: session.playerId,
    token_hash: session.tokenHash,
    created_at: session.createdAt,
    expires_at: session.expiresAt,
    revoked_at: session.revokedAt
  };
}

function fromSupabaseSession(row) {
  return {
    id: row.id,
    playerId: row.player_id,
    tokenHash: row.token_hash,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at
  };
}

async function recordMatchResults() {
  if (game.resultsRecorded) return;
  game.resultsRecorded = true;
  const entries = [...game.players.values()]
    .filter(player => player.accountId)
    .map(player => ({
      playerId: player.accountId,
      displayName: player.nickname,
      score: player.score,
      mathSolved: player.mathSolved,
      won: game.winner?.id === player.id
    }));
  if (entries.length) await authStore.recordMatch(entries);
}

function formatLeaderboard(rows, limit) {
  return [...rows]
    .sort((a, b) => b.totalScore - a.totalScore || b.wins - a.wins || a.gamesPlayed - b.gamesPlayed)
    .slice(0, limit)
    .map((row, index) => ({ rank: index + 1, ...row }));
}

function readAuthState() {
  try {
    return JSON.parse(fs.readFileSync(AUTH_FILE, "utf8"));
  } catch {
    return { players: [], sessions: [] };
  }
}

function writeAuthState(state) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(AUTH_FILE, `${JSON.stringify(state, null, 2)}\n`);
}

function hashPin(pin, salt) {
  return crypto.pbkdf2Sync(pin, salt, 160000, 32, "sha256").toString("base64url");
}

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("base64url");
}

function tooManyAttempts(key) {
  const now = Date.now();
  const bucket = loginAttempts.get(key) || [];
  const recent = bucket.filter(at => now - at < 60000);
  recent.push(now);
  loginAttempts.set(key, recent);
  return recent.length > 8;
}

function cleanNickname(value) {
  return String(value || "").trim().replace(/\s+/g, " ").slice(0, 18);
}

function normalizeName(value) {
  return cleanNickname(value).toLowerCase();
}

function publicPlayer(player) {
  return {
    id: player.id,
    displayName: player.displayName
  };
}

function result(status, error) {
  return { status, payload: { ok: false, error } };
}

function readBearer(req) {
  const header = req.headers.authorization || "";
  return header.startsWith("Bearer ") ? header.slice(7) : "";
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": process.env.CORS_ORIGIN || "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS"
  });
  if (status === 204) res.end();
  else res.end(JSON.stringify(payload));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", chunk => {
      raw += chunk;
      if (raw.length > 8192) {
        req.destroy();
        reject(new Error("too large"));
      }
    });
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function snapshot() {
  const now = Date.now();
  return {
    type: "state",
    phase: game.phase,
    me: null,
    grid: { w: GRID_W, h: GRID_H },
    mapVersion,
    players: [...game.players.values()].map(p => ({
      id: p.id,
      nickname: p.nickname,
      color: p.color,
      symbol: p.symbol,
      x: p.x,
      y: p.y,
      spawn: p.spawn,
      lives: p.lives,
      alive: p.alive,
      invulnerable: p.invulnerableUntil > now || (game.mode === "friendly" && Boolean(p.challenge)),
      bombsMax: p.bombsMax,
      flameRange: p.flameRange,
      speed: p.speed,
      placedBombs: p.placedBombs,
      score: p.score,
      mathSolved: p.mathSolved,
      challenge: Boolean(p.challenge)
    })),
    bombs: game.bombs.map(b => ({ id: b.id, x: b.x, y: b.y, fuse: Math.max(0, b.explodesAt - now) })),
    explosions: game.explosions,
    powerups: game.powerups,
    mathTokens: game.mathTokens,
    mode: game.mode,
    difficulty: game.difficulty,
    lobby: {
      count: game.players.size,
      max: 4,
      lobbyRemaining: lobbyDeadline ? Math.max(0, Math.ceil((lobbyDeadline - now) / 1000)) : 20,
      readyRemaining: readyDeadline ? Math.max(0, Math.ceil((readyDeadline - now) / 1000)) : null
    },
    winner: game.winner
      ? {
          id: game.winner.id,
          nickname: game.winner.nickname,
          color: game.winner.color,
          symbol: game.winner.symbol
        }
      : null,
    matchElapsed: game.startedAt ? Math.floor((now - game.startedAt) / 1000) : 0
  };
}

function broadcastState(force) {
  const state = snapshot();
  for (const client of clients.values()) {
    const me = game.players.get(client.playerId);
    const includeMap = force || client.mapVersion !== mapVersion;
    send(client, {
      ...state,
      map: includeMap ? game.map : null,
      me: client.playerId,
      challenge: me?.challenge ? { id: me.challenge.id, prompt: me.challenge.prompt } : null,
      force
    });
    if (includeMap) client.mapVersion = mapVersion;
  }
}

function broadcast(message) {
  for (const client of clients.values()) send(client, message);
}

function send(client, data) {
  if (client.socket.destroyed) return;
  const payload = Buffer.from(JSON.stringify(data));
  const header = payload.length < 126
    ? Buffer.from([0x81, payload.length])
    : Buffer.from([0x81, 126, payload.length >> 8, payload.length & 255]);
  client.socket.write(Buffer.concat([header, payload]));
}

function decodeFrames(client, chunk) {
  const messages = [];
  const buffer = Buffer.concat([client.frameBuffer, chunk]);
  let offset = 0;
  while (offset + 2 <= buffer.length) {
    const frameStart = offset;
    const byte1 = buffer[offset++];
    const byte2 = buffer[offset++];
    const opcode = byte1 & 0x0f;
    let length = byte2 & 0x7f;
    if (length === 126) {
      if (offset + 2 > buffer.length) {
        offset = frameStart;
        break;
      }
      length = buffer.readUInt16BE(offset);
      offset += 2;
    } else if (length === 127) {
      if (offset + 8 > buffer.length) {
        offset = frameStart;
        break;
      }
      length = Number(buffer.readBigUInt64BE(offset));
      offset += 8;
    }
    const masked = Boolean(byte2 & 0x80);
    if (masked && offset + 4 > buffer.length) {
      offset = frameStart;
      break;
    }
    const mask = masked ? buffer.subarray(offset, offset + 4) : null;
    if (masked) offset += 4;
    if (offset + length > buffer.length) {
      offset = frameStart;
      break;
    }
    const payload = buffer.subarray(offset, offset + length);
    offset += length;

    if (opcode === 0x8) {
      client.frameBuffer = Buffer.alloc(0);
      return messages;
    }
    if (opcode !== 0x1) continue;
    const decoded = Buffer.alloc(payload.length);
    for (let i = 0; i < payload.length; i++) decoded[i] = masked ? payload[i] ^ mask[i % 4] : payload[i];
    messages.push(decoded.toString("utf8"));
  }
  client.frameBuffer = buffer.subarray(offset);
  return messages;
}

setInterval(loop, TICK_MS);
server.listen(PORT, HOST, () => {
  console.log(`Math Bomber Arena server running at http://${HOST}:${PORT}`);
});

function normalizeMode(value) {
  return MODES.has(value) ? value : "friendly";
}

function normalizeDifficulty(value) {
  return DIFFICULTIES.has(value) ? value : "easy";
}
