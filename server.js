// Worm Zone — Multiplayer Server
// Authoritative game loop: this server owns the real positions of every
// player, every food item, and decides all collisions. Every connected
// browser is just a "screen + controller" — it sends its mouse direction,
// and receives the world state to draw every frame.

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' } // allow the game website (hosted elsewhere) to connect
});

const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.send('Worm Zone multiplayer server is running.');
});

// ---------------- Game constants ----------------
const WORLD_R = 2200;
const FOOD_COUNT = 220;
const TICK_RATE = 20; // server updates per second
const SPECIAL_CHANCE = { candy: 0.14, bigcandy: 0.03, bonus: 0.045, heart: 0.045, mult2: 0.03, mult4: 0.018, mult8: 0.008, mult16: 0.003 };
const MULT_DURATION = 30;

const fruitShapes = ['grape', 'cherry', 'orange', 'banana', 'apple', 'watermelon'];

function rand(a, b) { return a + Math.random() * (b - a); }
function dist2(a, b) { const dx = a.x - b.x, dy = a.y - b.y; return dx * dx + dy * dy; }
function angleLerp(a, b, t) {
  let diff = ((b - a + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
  return a + diff * t;
}

// ---------------- World state ----------------
let food = [];
const players = {}; // socket.id -> worm state (both real players and bots share this)

const botNames = ['كوبرا','فايبر','نمر','صاعقة','ظل','نينجا٧','جوكر','عاصفة','رمح','برق','كوماندو','ذئب','سهم','جمرة'];
const botSkins = [
  { c: '#8fffb0', stripes: ['#8fffb0'] },
  { c: '#5fd8ff', stripes: ['#5fd8ff'] },
  { c: '#ff9f5f', stripes: ['#ff9f5f'] },
  { c: '#ff5f8f', stripes: ['#ff5f8f'] },
  { c: '#c48fff', stripes: ['#c48fff'] },
  { c: '#ffe45f', stripes: ['#ffe45f'] }
];
const MAX_BOTS = 10;      // how many bots fill the arena when it's empty
const MIN_HUMANS_FOR_ZERO_BOTS = 6; // bots fade out once this many real players are in

function makeFoodItem(x, y) {
  const pulse = Math.random() * 10;
  const r = Math.random();
  if (r < SPECIAL_CHANCE.mult16) return { x, y, type: 'mult', value: 16, r: 11, pulse };
  if (r < SPECIAL_CHANCE.mult16 + SPECIAL_CHANCE.mult8) return { x, y, type: 'mult', value: 8, r: 10, pulse };
  if (r < SPECIAL_CHANCE.mult16 + SPECIAL_CHANCE.mult8 + SPECIAL_CHANCE.mult4) return { x, y, type: 'mult', value: 4, r: 9, pulse };
  if (r < SPECIAL_CHANCE.mult16 + SPECIAL_CHANCE.mult8 + SPECIAL_CHANCE.mult4 + SPECIAL_CHANCE.mult2) return { x, y, type: 'mult', value: 2, r: 8, pulse };
  const base = SPECIAL_CHANCE.mult16 + SPECIAL_CHANCE.mult8 + SPECIAL_CHANCE.mult4 + SPECIAL_CHANCE.mult2;
  if (r < base + SPECIAL_CHANCE.heart) return { x, y, type: 'heart', r: 12, pulse };
  if (r < base + SPECIAL_CHANCE.heart + SPECIAL_CHANCE.bonus) return { x, y, type: 'bonus', r: 13, pulse };
  if (r < base + SPECIAL_CHANCE.heart + SPECIAL_CHANCE.bonus + SPECIAL_CHANCE.bigcandy) {
    return { x, y, type: 'bigcandy', r: 16, color: ['#ff5f8f', '#5fd8ff', '#ffe45f', '#c48fff'][Math.floor(Math.random() * 4)], pulse };
  }
  if (r < base + SPECIAL_CHANCE.heart + SPECIAL_CHANCE.bonus + SPECIAL_CHANCE.bigcandy + SPECIAL_CHANCE.candy) {
    return { x, y, type: 'candy', r: 8, color: ['#ff5f8f', '#5fd8ff', '#ffe45f'][Math.floor(Math.random() * 3)], pulse };
  }
  return { x, y, type: 'fruit', shape: fruitShapes[Math.floor(Math.random() * fruitShapes.length)], r: rand(10, 13), rot: Math.random() * Math.PI * 2 };
}

function spawnFood(n) {
  for (let i = 0; i < n; i++) {
    const ang = Math.random() * Math.PI * 2;
    const r = Math.sqrt(Math.random()) * WORLD_R * 0.97;
    food.push(makeFoodItem(Math.cos(ang) * r, Math.sin(ang) * r));
  }
}
spawnFood(FOOD_COUNT);

function makeWorm(id, name, skin, pattern, face, isBot) {
  const ang = Math.random() * Math.PI * 2;
  const spawnR = Math.random() * WORLD_R * 0.6;
  const x = Math.cos(ang) * spawnR, y = Math.sin(ang) * spawnR;
  const segs = [];
  for (let i = 0; i < 10; i++) segs.push({ x: x - i * 6, y });
  return {
    id, name: (name || 'لاعب').slice(0, 12),
    color: skin?.c || '#8fffb0',
    stripes: skin?.stripes || ['#8fffb0'],
    emoji: skin?.emoji || null,
    pattern: pattern || 'صلب',
    face: face || 'عادي',
    segs,
    dir: Math.random() * Math.PI * 2,
    targetDir: Math.random() * Math.PI * 2,
    speed: 2.1,
    boosting: false,
    alive: true,
    isBot: !!isBot,
    thickness: 15,
    _targetLen: 10,
    multiplier: 1,
    multTimeLeft: 0,
    lives: 0,
    _boostTick: 0,
    _wanderTimer: 0,
    _foodScanTimer: 0,
    _foodTargetAngle: null
  };
}

function makeBot() {
  const id = 'bot-' + Math.random().toString(36).slice(2, 9);
  const name = botNames[Math.floor(Math.random() * botNames.length)];
  const skin = botSkins[Math.floor(Math.random() * botSkins.length)];
  players[id] = makeWorm(id, name, skin, 'صلب', 'عادي', true);
}

function countHumans() {
  return Object.values(players).filter(w => !w.isBot).length;
}
function countBots() {
  return Object.values(players).filter(w => w.isBot).length;
}

// Keep the arena populated when few real players are around, and thin bots
// out as more real players join so humans aren't crowded out.
function manageBotPopulation() {
  const humans = countHumans();
  const bots = countBots();
  const targetBots = Math.max(0, Math.round(MAX_BOTS * (1 - humans / MIN_HUMANS_FOR_ZERO_BOTS)));

  if (bots < targetBots) {
    makeBot();
  } else if (bots > targetBots) {
    const botIds = Object.keys(players).filter(id => players[id].isBot);
    if (botIds.length) delete players[botIds[0]];
  }
}
setInterval(manageBotPopulation, 3000);
// seed a few bots immediately so the arena isn't empty on first boot
for (let i = 0; i < MAX_BOTS; i++) makeBot();

function growWorm(w, amount) {
  w._targetLen += amount * (w.multiplier || 1);
  const newThick = Math.min(32, 15 + Math.floor(w._targetLen / 16) * 1.1);
  w.thickness = newThick;
}

function applyMultiplier(w, value) {
  w.multiplier = w.multTimeLeft > 0 ? w.multiplier + value : value;
  w.multTimeLeft = MULT_DURATION;
}

function dropLoot(segs) {
  for (let i = 0; i < segs.length; i += 2) {
    const s = segs[i];
    const roll = Math.random();
    if (roll < 0.12) {
      food.push({ x: s.x, y: s.y, type: 'candy', r: 8, color: ['#ff5f8f', '#5fd8ff', '#ffe45f'][Math.floor(Math.random() * 3)] });
    } else if (roll < 0.15) {
      food.push({ x: s.x, y: s.y, type: 'bonus', r: 13 });
    } else {
      food.push({ x: s.x, y: s.y, type: 'fruit', shape: fruitShapes[Math.floor(Math.random() * fruitShapes.length)], r: rand(9, 12), rot: Math.random() * Math.PI * 2 });
    }
  }
}

function respawnWorm(w) {
  const keepLen = Math.max(10, Math.floor(w.segs.length * 0.6));
  const ang = Math.random() * Math.PI * 2;
  const spawnR = Math.random() * WORLD_R * 0.4;
  const x = Math.cos(ang) * spawnR, y = Math.sin(ang) * spawnR;
  const segs = [];
  for (let i = 0; i < keepLen; i++) segs.push({ x: x - i * 6, y });
  w.segs = segs;
  w._targetLen = keepLen;
  w.dir = Math.random() * Math.PI * 2;
  w.targetDir = w.dir;
}

function killWorm(w) {
  dropLoot(w.segs);

  if (w.isBot) {
    // bots don't have a real socket to notify — just remove them;
    // manageBotPopulation() will spawn a fresh replacement shortly
    delete players[w.id];
    return;
  }

  if (w.lives > 0) {
    w.lives--;
    respawnWorm(w);
    io.to(w.id).emit('youRespawned', { livesLeft: w.lives });
    return;
  }
  w.alive = false;
  io.to(w.id).emit('youDied', { finalLength: w.segs.length });
}

function eatFood(w) {
  const head = w.segs[0];
  const reach = 14 + w.thickness;
  for (let i = food.length - 1; i >= 0; i--) {
    const f = food[i];
    const dx = f.x - head.x, dy = f.y - head.y;
    if (dx * dx + dy * dy < reach * reach) {
      food.splice(i, 1);
      if (f.type === 'fruit') growWorm(w, 3);
      else if (f.type === 'candy') growWorm(w, 6);
      else if (f.type === 'bigcandy') growWorm(w, 12);
      else if (f.type === 'bonus') growWorm(w, 18);
      else if (f.type === 'heart') { w.lives++; growWorm(w, 3); }
      else if (f.type === 'mult') applyMultiplier(w, f.value);
      if (food.length < FOOD_COUNT) spawnFood(1);
    }
  }
}

function updateBotAI(w, dt) {
  w._wanderTimer -= dt;
  if (w._wanderTimer <= 0) {
    w._wanderTimer = rand(1.2, 2.6);
    w.targetDir += rand(-0.9, 0.9);
  }

  // throttle the food scan so bots don't scan the whole food list every tick
  w._foodScanTimer -= dt;
  if (w._foodScanTimer <= 0) {
    w._foodScanTimer = 0.2;
    const head = w.segs[0];
    let closest = null, cd = 220 * 220;
    for (let i = 0; i < food.length; i += 3) {
      const f = food[i];
      const priority = (f.type === 'mult') ? (2 + f.value * 0.15) : (f.type === 'bonus' || f.type === 'heart') ? 2.4 : (f.type === 'bigcandy' ? 2 : f.type === 'candy' ? 1.5 : 1);
      const d = dist2(head, f) / priority;
      if (d < cd) { cd = d; closest = f; }
    }
    w._foodTargetAngle = closest ? Math.atan2(closest.y - w.segs[0].y, closest.x - w.segs[0].x) : null;
  }
  if (w._foodTargetAngle !== null) {
    w.targetDir = angleLerp(w.targetDir, w._foodTargetAngle, 0.4);
  }

  const head = w.segs[0];
  const distFromCenter = Math.hypot(head.x, head.y);
  if (distFromCenter > WORLD_R * 0.85) {
    const toCenter = Math.atan2(-head.y, -head.x);
    w.targetDir = angleLerp(w.targetDir, toCenter, 0.5);
  }

  // occasionally toggle boost for variety
  if (Math.random() < 0.002 && w.segs.length > 30) w.boosting = true;
  else if (Math.random() < 0.02) w.boosting = false;
}

function updateWorm(w, dt) {
  if (!w.alive) return;
  if (w.multTimeLeft > 0) {
    w.multTimeLeft -= dt;
    if (w.multTimeLeft <= 0) { w.multTimeLeft = 0; w.multiplier = 1; }
  }

  if (w.isBot) updateBotAI(w, dt);

  w.dir = angleLerp(w.dir, w.targetDir, w.isBot ? 0.09 : 0.18);
  const spd = w.boosting ? w.speed * 1.9 : w.speed;
  const head = w.segs[0];
  const nx = head.x + Math.cos(w.dir) * spd;
  const ny = head.y + Math.sin(w.dir) * spd;
  w.segs.unshift({ x: nx, y: ny });

  if (w.boosting && w.segs.length > 20) {
    w._boostTick = (w._boostTick || 0) + 1;
    if (w._boostTick % 8 === 0) {
      const tail = w.segs[w.segs.length - 1];
      if (Math.random() < 0.5) food.push({ x: tail.x, y: tail.y, type: 'fruit', shape: 'grape', r: 3.5, rot: 0 });
      w.segs.pop();
      w._targetLen = Math.max(12, w._targetLen - 1);
    }
  }
  w.segs.pop();
  let growStep = 2;
  while (w.segs.length < w._targetLen && growStep > 0) {
    const tail = w.segs[w.segs.length - 1];
    w.segs.push({ x: tail.x, y: tail.y });
    growStep--;
  }
}

function checkCollisions() {
  const ids = Object.keys(players);
  for (const id of ids) {
    const w = players[id];
    if (!w.alive) continue;
    const head = w.segs[0];

    if (Math.hypot(head.x, head.y) > WORLD_R) {
      killWorm(w);
      continue;
    }

    for (const otherId of ids) {
      if (otherId === id) continue;
      const other = players[otherId];
      if (!other.alive) continue;

      const hdx = other.segs[0].x - head.x, hdy = other.segs[0].y - head.y;
      const broadReach = 400 + other.segs.length * 3;
      if (hdx * hdx + hdy * hdy > broadReach * broadReach) continue;

      for (let i = 0; i < other.segs.length; i += 2) {
        const s = other.segs[i];
        const dx = s.x - head.x, dy = s.y - head.y;
        const rr = other.thickness * 0.5 + 3;
        if (dx * dx + dy * dy < rr * rr) {
          killWorm(w);
          break;
        }
      }
      if (!w.alive) break;
    }
  }
}

// ---------------- Socket connections ----------------
io.on('connection', (socket) => {
  socket.on('join', (data) => {
    const skin = data?.skin || {};
    players[socket.id] = makeWorm(socket.id, data?.name, skin, data?.pattern, data?.face, false);
    socket.emit('joined', { id: socket.id, worldRadius: WORLD_R });
    manageBotPopulation();
  });

  socket.on('input', (data) => {
    const w = players[socket.id];
    if (!w || !w.alive) return;
    if (typeof data.angle === 'number') w.targetDir = data.angle;
    w.boosting = !!data.boosting && w.segs.length > 20;
  });

  socket.on('respawnRequest', (data) => {
    const skin = data?.skin || {};
    players[socket.id] = makeWorm(socket.id, data?.name, skin, data?.pattern, data?.face);
    socket.emit('joined', { id: socket.id, worldRadius: WORLD_R });
  });

  socket.on('leave', () => {
    delete players[socket.id];
    manageBotPopulation();
  });

  socket.on('disconnect', () => {
    delete players[socket.id];
    manageBotPopulation();
  });
});

// ---------------- Main game loop ----------------
let lastTick = Date.now();
setInterval(() => {
  const now = Date.now();
  const dt = (now - lastTick) / 1000;
  lastTick = now;

  for (const id in players) updateWorm(players[id], dt);
  for (const id in players) { if (players[id].alive) eatFood(players[id]); }
  checkCollisions();

  // broadcast compact world state to everyone.
  // Sending every segment for every worm at 30x/sec gets heavy fast as worms
  // grow, so we thin the segment list (every 3rd point) — the client already
  // draws using a stride, so visual smoothness barely changes.
  const worms = Object.values(players)
    .filter(w => w.alive)
    .map(w => ({
      id: w.id, name: w.name, color: w.color, stripes: w.stripes, emoji: w.emoji,
      pattern: w.pattern, face: w.face, dir: w.dir, thickness: w.thickness,
      multiplier: w.multiplier, multTimeLeft: Math.ceil(w.multTimeLeft),
      lives: w.lives,
      segs: w.segs.filter((_, i) => i % 3 === 0)
    }));

  io.emit('state', { worms, food, worldRadius: WORLD_R });
}, 1000 / TICK_RATE);

server.listen(PORT, () => {
  console.log(`Worm Zone server listening on port ${PORT}`);
});
