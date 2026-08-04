const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";
const PUBLIC_DIR = process.env.PUBLIC_DIR || path.join(__dirname, "../web/public");
const TICK_MS = 1000 / 60;
const BROADCAST_MS = 1000 / 30;
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

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml"
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
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

function handleMessage(client, raw) {
  let message;
  try {
    message = JSON.parse(raw);
  } catch {
    return;
  }

  if (message.type === "join") {
    joinGame(
      client,
      String(message.nickname || "Player").slice(0, 18).trim() || "Player",
      normalizeMode(message.mode),
      normalizeDifficulty(message.difficulty)
    );
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
  }
}

function joinGame(client, nickname, mode, difficulty) {
  if (client.playerId || game.phase !== "lobby" || game.players.size >= 4) return;
  if (game.players.size === 0) {
    game.mode = mode;
    game.difficulty = difficulty;
  }

  const id = nextPlayerId++;
  const start = STARTS[game.players.size];
  const player = {
    id,
    nickname,
    color: COLORS[game.players.size],
    symbol: SYMBOLS[game.players.size],
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
    mathSolved: 0
  };
  game.players.set(id, player);
  client.playerId = id;
  client.nickname = nickname;
  send(client, { type: "joined", playerId: id });
  broadcast({ type: "system", text: `${nickname} joined the arena.` });
  updateLobbyTimers();
  broadcastState(true);
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
  game.players.clear();
  game.bombs = [];
  game.explosions = [];
  game.powerups = [];
  game.mathTokens = [];
  game.mode = "friendly";
  game.difficulty = "easy";
  game.winner = null;
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
  game.bombs = [];
  game.explosions = [];
  game.powerups = [];
  game.mathTokens = [];
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
      if (op === "*") return { a: rand(2, 9), op, b: rand(2, 9), answer: 0 };
      if (op === "/") return division(9, 9);
      const a = rand(5, 35);
      const b = rand(2, 25);
      return op === "+" ? { a, op, b, answer: a + b } : { a: Math.max(a, b), op, b: Math.min(a, b), answer: Math.abs(a - b) };
    },
    hard: () => {
      const op = ["+", "-", "*", "/"][rand(0, 3)];
      if (op === "*") return { a: rand(7, 13), op, b: rand(6, 12), answer: 0 };
      if (op === "/") return division(12, 12);
      const a = rand(28, 99);
      const b = rand(18, 89);
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
  }
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

function snapshot() {
  const now = Date.now();
  return {
    type: "state",
    phase: game.phase,
    me: null,
    grid: { w: GRID_W, h: GRID_H },
    map: game.map,
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
    send(client, {
      ...state,
      me: client.playerId,
      challenge: me?.challenge ? { id: me.challenge.id, prompt: me.challenge.prompt } : null,
      force
    });
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
