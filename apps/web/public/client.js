import { $, $$, h, on, setChildren } from "./mini-framework.js";

const joinForm = $("#joinForm");
const gate = $("#gate");
const gameScreen = $("#gameScreen");
const arena = $("#arena");
const phase = $("#phase");
const counter = $("#counter");
const timer = $("#timer");
const room = $("#room");
const playersCount = $("#playersCount");
const matchClock = $("#matchClock");
const scoreboard = $("#scoreboard");
const lobbySectors = $("#lobbySectors");
const matchOverlay = $("#matchOverlay");
const messages = $("#messages");
const chatForm = $("#chatForm");
const chatInput = $("#chatInput");
const restart = $("#restart");
const chat = $(".chat");
const gameTitle = $("#gameTitle");
const tagline = $("#tagline");
const joinButton = $("#joinButton");
const mathModal = $("#mathModal");
const mathPrompt = $("#mathPrompt");
const mathMode = $("#mathMode");
const mathAnswer = $("#mathAnswer");
const calculator = $("#calculator");
const touchButtons = $$("[data-touch-key]");

const state = {
  socket: null,
  joined: false,
  me: null,
  game: null,
  keys: new Set(),
  touch: { up: false, down: false, left: false, right: false, bomb: false },
  lastInput: "",
  answer: "",
  challengeId: null,
  previousMap: null,
  previousLives: new Map(),
  previousStats: new Map(),
  previousPositions: new Map(),
  explosionIds: new Set(),
  tiles: new Map(),
  entities: {
    bomb: new Map(),
    explosion: new Map(),
    powerup: new Map(),
    mathToken: new Map(),
    player: new Map()
  },
  scoreboardSig: "",
  lobbySig: "",
  overlaySig: "",
  renderQueued: false
};

document.title = "Math Bomber Arena";
gameTitle.textContent = "Math Bomber Arena";
tagline.textContent = "Bomb blocks, grab math tokens, solve fast.";
joinButton.textContent = "Join";
buildCalculator();

function connect() {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const endpoint = window.MATH_BOMBER_WS_URL || `${protocol}//${location.host}`;
  state.socket = new WebSocket(endpoint);
  on(state.socket, "message", event => {
    const message = JSON.parse(event.data);
    if (message.type === "state") {
      state.game = message;
      state.me = message.me;
      scheduleRender();
    } else if (message.type === "joined") {
      state.joined = true;
      gate.classList.add("is-hidden");
      gameScreen.classList.remove("is-hidden");
    } else if (message.type === "chat") {
      appendMessage(message.from, message.text, message.color, message.at);
    } else if (message.type === "system") {
      appendSystem(message.text);
    }
  });
  on(state.socket, "close", () => {
    appendSystem("Connection lost. Refresh to reconnect.");
  });
}

on(joinForm, "submit", event => {
  event.preventDefault();
  const data = new FormData(joinForm);
  send({
    type: "join",
    nickname: data.get("nickname"),
    mode: data.get("mode"),
    difficulty: data.get("difficulty")
  });
});

on(chatForm, "submit", event => {
  event.preventDefault();
  const text = chatInput.value.trim();
  if (!text) return;
  send({ type: "chat", text });
  chatInput.value = "";
});

on(restart, "click", () => {
  send({ type: "restart" });
  gate.classList.remove("is-hidden");
  gameScreen.classList.add("is-hidden");
  state.joined = false;
});

on(window, "keydown", event => {
  if (["INPUT", "TEXTAREA"].includes(document.activeElement?.tagName)) return;
  if (state.challengeId) {
    handleMathKey(event);
    return;
  }
  if (event.code === "Space") event.preventDefault();
  if (state.keys.has(event.code)) return;
  state.keys.add(event.code);
  sendInput();
});

on(window, "keyup", event => {
  if (!state.keys.has(event.code)) return;
  state.keys.delete(event.code);
  sendInput();
});

function send(payload) {
  if (state.socket?.readyState === WebSocket.OPEN) state.socket.send(JSON.stringify(payload));
}

function sendInput() {
  const input = {
    up: state.keys.has("ArrowUp") || state.keys.has("KeyW") || state.touch.up,
    down: state.keys.has("ArrowDown") || state.keys.has("KeyS") || state.touch.down,
    left: state.keys.has("ArrowLeft") || state.keys.has("KeyA") || state.touch.left,
    right: state.keys.has("ArrowRight") || state.keys.has("KeyD") || state.touch.right,
    bomb: state.keys.has("Space") || state.touch.bomb
  };
  const encoded = JSON.stringify(input);
  if (encoded !== state.lastInput) {
    send({ type: "input", input });
    state.lastInput = encoded;
  }
}

function scheduleRender() {
  if (state.renderQueued) return;
  state.renderQueued = true;
  requestAnimationFrame(() => {
    state.renderQueued = false;
    if (state.game) render(state.game);
  });
}

function render(game) {
  document.body.dataset.phase = game.phase;
  setText(phase, game.phase === "playing" ? "Battle in progress" : game.phase === "ended" ? "Game over" : "Lobby");
  setText(counter, `${game.lobby.count} / ${game.lobby.max}`);
  setText(room, `${game.mode || "friendly"} / ${game.difficulty || "easy"}`);
  setText(playersCount, `PLAYERS ${game.lobby.count}/${game.lobby.max}`);
  setText(matchClock, formatClock(game.matchElapsed || 0));
  restart.classList.toggle("is-hidden", game.phase !== "ended");
  chat.classList.toggle("compact", game.phase === "playing");

  if (game.phase === "lobby") {
    setText(timer, game.lobby.readyRemaining !== null
      ? `Starting in ${game.lobby.readyRemaining}s`
      : game.lobby.count >= 2
        ? `Ready window opens in ${game.lobby.lobbyRemaining}s`
        : "Waiting for at least 2 players");
  } else if (game.phase === "ended") {
    setText(timer, game.winner ? `${game.winner.nickname} is victorious` : "No survivors");
  } else {
    setText(timer, game.challenge ? "Solve the challenge to move again." : "WASD or arrows move. Space drops bomb.");
  }

  renderMap(game.map);
  renderCollection("bomb", game.bombs, b => ({ id: b.id, x: b.x, y: b.y, fuse: b.fuse }));
  renderCollection("explosion", game.explosions.flatMap(e => e.cells.map((cell, index) => ({ id: `${e.id}-${index}`, ...cell }))), e => e);
  renderCollection("powerup", game.powerups, p => ({ ...p, label: powerupLabel(p.type), aria: powerupName(p.type), type: p.type }));
  renderCollection("mathToken", game.mathTokens || [], token => ({ ...token, label: "=", aria: "Math challenge token" }));
  renderPlayers(game.players);
  renderScoreboard(game.players, game.me);
  renderLobbySectors(game);
  renderOverlay(game);
  renderMathModal(game);
  runExplosionEffects(game);
}

function renderMap(map) {
  const needed = new Set();
  map.forEach((row, y) => {
    row.forEach((type, x) => {
      const key = `tile-${x}-${y}`;
      needed.add(key);
      let el = state.tiles.get(key);
      if (!el) {
        el = h("div", { className: "tile", dataset: { key }, "--x": x, "--y": y });
        state.tiles.set(key, el);
        arena.append(el);
      }
      const previousType = state.previousMap?.[y]?.[x];
      if (previousType !== type) el.className = `tile ${type}`;
      if (previousType === "block" && type === "empty") createDebris(x, y);
    });
  });
  for (const [key, el] of state.tiles) {
    if (!needed.has(key)) {
      el.remove();
      state.tiles.delete(key);
    }
  }
  state.previousMap = map.map(row => [...row]);
}

function renderCollection(className, items, normalize) {
  const needed = new Set();
  const store = state.entities[className];
  for (const item of items.map(normalize)) {
    const key = `${className}-${item.id}`;
    needed.add(key);
    let el = store.get(key);
    if (!el) {
      el = h("div", { dataset: { key } });
      store.set(key, el);
      arena.append(el);
    }
    el.className = `entity ${className}${item.type ? ` ${className}--${item.type}` : ""}`;
    if (className === "powerup") el.classList.add("power-up", `power-up--${item.type}`);
    el.style.setProperty("--x", item.x);
    el.style.setProperty("--y", item.y);
    if (item.fuse !== undefined) {
      el.style.setProperty("--pulse", `${Math.max(160, item.fuse / 4)}ms`);
      el.classList.toggle("urgent", item.fuse < 850);
    }
    if (item.aria) el.setAttribute("aria-label", item.aria);
    if (item.label) el.textContent = item.label;
  }
  removeMissing(store, needed);
}

function renderPlayers(players) {
  const needed = new Set();
  const store = state.entities.player;
  for (const player of players) {
    const key = `player-${player.id}`;
    needed.add(key);
    let el = store.get(key);
    if (!el) {
      el = h("div", { dataset: { key } });
      store.set(key, el);
      arena.append(el);
    }
    const previous = state.previousPositions.get(player.id);
    const isMoving = previous && player.alive && Math.hypot(previous.x - player.x, previous.y - player.y) > 0.04;
    const previousLives = state.previousLives.get(player.id);
    const previousStats = state.previousStats.get(player.id);
    const poweredUp = previousStats && (
      previousStats.bombsMax < player.bombsMax ||
      previousStats.flameRange < player.flameRange ||
      previousStats.speed < player.speed
    );
    el.className = [
      "entity",
      "player",
      player.alive ? "" : "dead player--eliminated",
      player.invulnerable ? "invulnerable player--invulnerable" : "",
      isMoving ? "player--moving" : "",
      previousLives !== undefined && previousLives > player.lives ? "player--damaged" : "",
      poweredUp ? "player--powered" : ""
    ].filter(Boolean).join(" ");
    el.title = player.nickname;
    el.setAttribute("aria-label", `${slotLabel(player)} ${player.nickname}`);
    el.dataset.symbol = symbolGlyph(player.symbol);
    el.style.setProperty("--px", player.x);
    el.style.setProperty("--py", player.y);
    el.style.setProperty("--color", player.color);
    if (previous && player.alive && Math.hypot(previous.x - player.x, previous.y - player.y) > 0.18) {
      createTrail(previous.x, previous.y, player.color, player.symbol);
    }
    state.previousPositions.set(player.id, { x: player.x, y: player.y });
    state.previousStats.set(player.id, { bombsMax: player.bombsMax, flameRange: player.flameRange, speed: player.speed });
  }
  removeMissing(store, needed);
}

function removeMissing(store, needed) {
  for (const [key, el] of store) {
    if (!needed.has(key)) {
      el.remove();
      store.delete(key);
    }
  }
}

function renderScoreboard(players, me) {
  const sig = JSON.stringify(players.map(player => [player.id, player.nickname, player.lives, player.bombsMax, player.flameRange, player.speed, player.alive, player.color, player.id === me, player.score, player.mathSolved, Boolean(player.challenge)]));
  if (sig === state.scoreboardSig) return;
  state.scoreboardSig = sig;
  setChildren(scoreboard, players.map(player => {
    const previousLives = state.previousLives.get(player.id);
    state.previousLives.set(player.id, player.lives);
    return h("div", {
      className: `score-row${player.id === me ? " me" : ""}${previousLives !== undefined && previousLives > player.lives ? " hit" : ""}`
    }, [
      h("span", { className: "dot", style: { background: player.color } }),
      h("span", { text: `${slotLabel(player)} ${player.nickname}` }),
      h("span", {
        className: "stats",
        text: `${"♥".repeat(Math.max(0, player.lives)) || "0"}  ● x${player.bombsMax}  ✦ ${player.flameRange}  = ${player.mathSolved || 0}  score ${player.score}`
      })
    ]);
  }));
}

function renderLobbySectors(game) {
  lobbySectors.classList.toggle("is-hidden", game.phase !== "lobby");
  if (game.phase !== "lobby") return;
  const sig = JSON.stringify(game.players.map(player => [player.id, player.nickname, player.color, player.symbol]));
  if (sig === state.lobbySig) return;
  state.lobbySig = sig;
  const sectors = Array.from({ length: 4 }, (_, index) => {
    const player = game.players[index];
    return h("div", { className: `sector${player ? " active" : ""}` }, [
      h("span", { text: `P${index + 1}` }),
      h("b", { "--color": player?.color || "#20204a", dataset: { symbol: symbolGlyph(player?.symbol) } }),
      h("strong", { text: player?.nickname || "WAITING..." }),
      h("small", { text: player ? "READY" : "NO SIGNAL" })
    ]);
  });
  setChildren(lobbySectors, sectors);
}

function setText(el, value) {
  if (el.textContent !== value) el.textContent = value;
}

function renderOverlay(game) {
  const me = game.players.find(player => player.id === game.me);
  const visible = game.phase === "ended" || (me && !me.alive && game.phase === "playing");
  matchOverlay.classList.toggle("is-hidden", !visible);
  const sig = visible
    ? JSON.stringify([game.phase, game.winner?.id, game.winner?.nickname, game.winner?.color, me?.alive, me?.lives])
    : "hidden";
  if (sig === state.overlaySig) return;
  state.overlaySig = sig;
  if (game.phase === "ended") {
    setChildren(matchOverlay, [
      overlayLine("span", "SURVIVOR DETECTED"),
      overlayLine("strong", game.winner?.nickname || "NO SURVIVORS", game.winner?.color || "#ffe66d"),
      overlayLine("small", "MATCH COMPLETE")
    ]);
  } else if (me && !me.alive) {
    setChildren(matchOverlay, [
      overlayLine("span", "SYSTEM FAILURE"),
      overlayLine("strong", "LIVES DEPLETED"),
      overlayLine("small", "SPECTATOR MODE ENABLED")
    ]);
  }
}

function runExplosionEffects(game) {
  const ids = new Set(game.explosions.map(explosion => explosion.id));
  const hasNewExplosion = [...ids].some(id => !state.explosionIds.has(id));
  if (hasNewExplosion) {
    arena.classList.remove("shake");
    void arena.offsetWidth;
    arena.classList.add("shake");
  }
  state.explosionIds = ids;
}

function createTrail(x, y, color, symbol) {
  const trail = h("div", {
    className: "entity trail",
    dataset: { symbol: symbolGlyph(symbol) },
    "--px": x,
    "--py": y,
    "--color": color
  });
  arena.append(trail);
  window.setTimeout(() => trail.remove(), 180);
}

function createDebris(x, y) {
  for (let index = 0; index < 5; index++) {
    const bit = h("div", {
      className: "debris",
      "--x": x,
      "--y": y,
      "--dx": `${(Math.random() - 0.5) * 34}px`,
      "--dy": `${(Math.random() - 0.5) * 34}px`
    });
    arena.append(bit);
    window.setTimeout(() => bit.remove(), 320);
  }
}

function appendMessage(from, text, color = "#9296b8", at = Date.now()) {
  const el = h("div", { className: "message", "--author": color }, [
    h("time", { text: `[${formatTime(at)}]` }),
    h("strong", { text: from.toUpperCase() }),
    h("span", { text })
  ]);
  messages.append(el);
  messages.scrollTop = messages.scrollHeight;
}

function appendSystem(text) {
  const el = h("div", { className: "message system" }, [
    h("time", { text: `[${formatTime(Date.now())}]` }),
    h("span", { text: `SYSTEM: ${text}` })
  ]);
  messages.append(el);
  messages.scrollTop = messages.scrollHeight;
}

function powerupLabel(type) {
  return type === "bombs" ? "B+" : type === "flames" ? "F+" : "S+";
}

function powerupName(type) {
  return type === "bombs" ? "Bombs power-up, carry one more active bomb" : type === "flames" ? "Flames power-up, larger explosion range" : "Speed power-up, faster movement";
}

function buildCalculator() {
  const buttons = ["7", "8", "9", "4", "5", "6", "1", "2", "3", "Clear", "0", "Submit"];
  setChildren(calculator, buttons.map(label => h("button", {
    type: "button",
    className: label === "Submit" ? "submit-key" : label === "Clear" ? "clear-key" : "",
    text: label
  })));
  calculator.querySelectorAll("button").forEach(button => {
    on(button, "click", () => {
      if (button.textContent === "Submit") submitAnswer();
      else if (button.textContent === "Clear") setAnswer("");
      else setAnswer(`${state.answer}${button.textContent}`.slice(0, 5));
    });
  });
}

function renderMathModal(game) {
  const challenge = game.challenge;
  if (!challenge) {
    state.challengeId = null;
    state.answer = "";
    mathModal.classList.add("is-hidden");
    return;
  }
  if (state.challengeId !== challenge.id) {
    state.challengeId = challenge.id;
    setAnswer("");
  }
  mathModal.classList.remove("is-hidden");
  mathPrompt.textContent = challenge.prompt;
  mathMode.textContent = game.mode === "hardcore" ? "Hardcore: bombs still hurt" : "Friendly: protected";
}

function handleMathKey(event) {
  if (/^\d$/.test(event.key)) {
    event.preventDefault();
    setAnswer(`${state.answer}${event.key}`.slice(0, 5));
  } else if (event.key === "Backspace") {
    event.preventDefault();
    setAnswer(state.answer.slice(0, -1));
  } else if (event.key === "Enter") {
    event.preventDefault();
    submitAnswer();
  } else if (event.key === "Escape") {
    event.preventDefault();
    setAnswer("");
  }
}

function setAnswer(value) {
  state.answer = value;
  mathAnswer.textContent = value || "0";
}

function submitAnswer() {
  if (!state.challengeId || !state.answer) return;
  send({ type: "mathAnswer", answer: state.answer });
}

function symbolGlyph(symbol) {
  return { circle: "●", triangle: "▲", cross: "✕", diamond: "◆" }[symbol] || "●";
}

function slotLabel(player) {
  return `P${Math.max(1, player.id).toString().padStart(2, "0")}`;
}

function formatClock(totalSeconds) {
  const minutes = Math.floor(totalSeconds / 60).toString().padStart(2, "0");
  const seconds = Math.floor(totalSeconds % 60).toString().padStart(2, "0");
  return `${minutes}:${seconds}`;
}

function formatTime(value) {
  const date = new Date(value);
  return `${date.getHours().toString().padStart(2, "0")}:${date.getMinutes().toString().padStart(2, "0")}`;
}

function overlayLine(tag, text, color) {
  return h(tag, { text, style: color ? { color } : {} });
}

touchButtons.forEach(button => {
  const key = button.dataset.touchKey;
  const set = value => {
    state.touch[key] = value;
    sendInput();
  };
  on(button, "pointerdown", event => {
    event.preventDefault();
    button.setPointerCapture?.(event.pointerId);
    set(true);
  });
  on(button, "pointerup", event => {
    event.preventDefault();
    set(false);
  });
  on(button, "pointercancel", () => set(false));
  on(button, "lostpointercapture", () => set(false));
});

connect();
