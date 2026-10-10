/**
 * BEST FIGHTER — servidor da comunidade KOF 2002
 * Parte 1: contas, perfil, chat global/privado, jogadores online e desafios (aceitar/recusar + placar).
 *
 * Banco de dados: arquivo JSON simples em ./data/db.json (local) ou MongoDB (produção).
 */
require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

/* ------------------------------------------------------------------ */
/* Banco de dados (JSON ou MongoDB)                                    */
/* ------------------------------------------------------------------ */
const emptyDb = () => ({ users: {}, sessions: {}, globalChat: [], dms: {}, challenges: {} });
let db = emptyDb();

const { MongoClient } = require('mongodb');
let mongoCollection = null;

async function initDB() {
  if (process.env.MONGODB_URI) {
    console.log('Conectando ao MongoDB...');
    const client = new MongoClient(process.env.MONGODB_URI);
    await client.connect();
    mongoCollection = client.db().collection('bestfighter_db');
    const remoteDb = await mongoCollection.findOne({ _id: 'main' });
    if (remoteDb) db = { ...emptyDb(), ...remoteDb };
    console.log('MongoDB conectado.');
  } else {
    try {
      if (fs.existsSync(DB_FILE)) db = { ...emptyDb(), ...JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) };
    } catch (e) {
      console.error('Falha ao ler o banco JSON:', e.message);
    }
  }
}

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    if (mongoCollection) {
      try {
        await mongoCollection.updateOne({ _id: 'main' }, { $set: db }, { upsert: true });
      } catch (e) {
        console.error('Erro ao salvar no MongoDB:', e);
      }
    } else {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const tmp = DB_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(db));
      fs.renameSync(tmp, DB_FILE);
    }
  }, 500);
}
/* ------------------------------------------------------------------ */
/* Utilidades                                                          */
/* ------------------------------------------------------------------ */
const id = () => crypto.randomBytes(8).toString('hex');
const now = () => Date.now();
const keyOf = (u) => u.toLowerCase();
const clean = (s, max) => String(s ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max);

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}
function checkPassword(password, user) {
  const { hash } = hashPassword(password, user.salt);
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(user.hash, 'hex'));
}

const PLATFORMS = ['android-ggpo', 'pc-fightcade', 'pc-ggpo', 'outro'];
const CONTROLS = ['joystick', 'teclado', 'touch', 'controle'];
const FORMATS = ['FT3', 'FT5', 'FT7', 'FT10'];

/** Dados públicos do jogador (nunca envia senha). */
function publicUser(u) {
  return {
    username: u.username,
    avatar: u.avatar,
    platform: u.platform,
    control: u.control,
    emulatorId: u.emulatorId,
    team: u.team,
    city: u.city,
    bio: u.bio,
    wins: u.wins || 0,
    losses: u.losses || 0,
    createdAt: u.createdAt,
    online: onlineCount(u.username) > 0,
    status: userStatus(u.username),
  };
}

/* ------------------------------------------------------------------ */
/* HTTP (contas)                                                       */
/* ------------------------------------------------------------------ */
const app = express();
app.use(express.json({ limit: '50kb' }));
app.use(express.static(path.join(__dirname, 'public')));

function createSession(username) {
  const token = crypto.randomBytes(24).toString('hex');
  db.sessions[token] = { username, createdAt: now() };
  save();
  return token;
}
function userFromToken(token) {
  const s = token && db.sessions[token];
  return s ? db.users[keyOf(s.username)] : null;
}

app.post('/api/register', (req, res) => {
  const username = clean(req.body.username, 16);
  const password = String(req.body.password || '');
  if (!/^[A-Za-z0-9_\-]{3,16}$/.test(username))
    return res.status(400).json({ error: 'Nome deve ter 3 a 16 caracteres (letras, números, _ ou -).' });
  if (password.length < 6) return res.status(400).json({ error: 'A senha precisa ter pelo menos 6 caracteres.' });
  if (db.users[keyOf(username)]) return res.status(409).json({ error: 'Esse nome de lutador já existe.' });

  const { salt, hash } = hashPassword(password);
  db.users[keyOf(username)] = {
    username, salt, hash,
    avatar: 1 + Math.floor(Math.random() * 8),
    platform: PLATFORMS.includes(req.body.platform) ? req.body.platform : 'android-ggpo',
    control: CONTROLS.includes(req.body.control) ? req.body.control : 'touch',
    emulatorId: '', team: '', city: '', bio: '',
    wins: 0, losses: 0, createdAt: now(),
  };
  save();
  res.json({ token: createSession(username) });
});

app.post('/api/login', (req, res) => {
  const user = db.users[keyOf(clean(req.body.username, 16))];
  if (!user || !checkPassword(String(req.body.password || ''), user))
    return res.status(401).json({ error: 'Usuário ou senha incorretos.' });
  res.json({ token: createSession(user.username) });
});

app.post('/api/logout', (req, res) => {
  delete db.sessions[req.headers.authorization];
  save();
  res.json({ ok: true });
});

/* ------------------------------------------------------------------ */
/* Tempo real (Socket.io)                                              */
/* ------------------------------------------------------------------ */
const server = http.createServer(app);
const io = new Server(server);

/** username(lower) -> Set<socketId> */
const sockets = new Map();
const onlineCount = (u) => sockets.get(keyOf(u))?.size || 0;
function userStatus(username) {
  if (!onlineCount(username)) return 'offline';
  const inMatch = Object.values(db.challenges).some(
    (c) => c.status === 'accepted' && (keyOf(c.from) === keyOf(username) || keyOf(c.to) === keyOf(username))
  );
  return inMatch ? 'lutando' : 'online';
}
const toUser = (username, event, payload) => io.to('u:' + keyOf(username)).emit(event, payload);
const broadcastPresence = () => io.emit('players', Object.values(db.users).map(publicUser));
const dmKey = (a, b) => [keyOf(a), keyOf(b)].sort().join('|');

function sendChallenge(c) {
  toUser(c.from, 'challenge', c);
  toUser(c.to, 'challenge', c);
}

/* Anti-flood simples */
const lastMsg = new Map();
function flood(username) {
  const t = now();
  const prev = lastMsg.get(username) || 0;
  lastMsg.set(username, t);
  return t - prev < 600;
}

io.use((socket, next) => {
  const user = userFromToken(socket.handshake.auth?.token);
  if (!user) return next(new Error('unauthorized'));
  socket.data.username = user.username;
  next();
});

io.on('connection', (socket) => {
  const me = socket.data.username;
  const meKey = keyOf(me);
  socket.join('u:' + meKey);
  if (!sockets.has(meKey)) sockets.set(meKey, new Set());
  sockets.get(meKey).add(socket.id);

  const myChallenges = Object.values(db.challenges)
    .filter((c) => keyOf(c.from) === meKey || keyOf(c.to) === meKey)
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 50);

  const myDms = Object.entries(db.dms)
    .filter(([k]) => k.split('|').includes(meKey))
    .map(([k, msgs]) => ({ with: k.split('|').find((x) => x !== meKey) ?? meKey, last: msgs[msgs.length - 1] }))
    .map((d) => ({ ...d, with: db.users[d.with]?.username || d.with }));

  socket.emit('init', {
    me: publicUser(db.users[meKey]),
    players: Object.values(db.users).map(publicUser),
    globalChat: db.globalChat.slice(-100),
    challenges: myChallenges,
    conversations: myDms,
  });
  broadcastPresence();

  /* ---------- Perfil ---------- */
  socket.on('profile:update', (p, ack) => {
    const u = db.users[meKey];
    if (Number(p.avatar) >= 1 && Number(p.avatar) <= 8) u.avatar = Number(p.avatar);
    if (PLATFORMS.includes(p.platform)) u.platform = p.platform;
    if (CONTROLS.includes(p.control)) u.control = p.control;
    u.emulatorId = clean(p.emulatorId, 32);
    u.team = clean(p.team, 60);
    u.city = clean(p.city, 40);
    u.bio = clean(p.bio, 160);
    save();
    broadcastPresence();
    ack?.({ ok: true, me: publicUser(u) });
  });

  /* ---------- Chat global ---------- */
  socket.on('chat:global', (text) => {
    text = clean(text, 400);
    if (!text || flood(me)) return;
    const msg = { id: id(), from: me, text, at: now() };
    db.globalChat.push(msg);
    if (db.globalChat.length > 300) db.globalChat.splice(0, db.globalChat.length - 300);
    save();
    io.emit('chat:global', msg);
  });

  /* ---------- Chat privado ---------- */
  socket.on('dm:send', ({ to, text }) => {
    const target = db.users[keyOf(String(to || ''))];
    text = clean(text, 400);
    if (!target || !text || flood(me)) return;
    const k = dmKey(me, target.username);
    const msg = { id: id(), from: me, to: target.username, text, at: now() };
    (db.dms[k] ||= []).push(msg);
    if (db.dms[k].length > 300) db.dms[k].splice(0, db.dms[k].length - 300);
    save();
    toUser(me, 'dm', msg);
    if (keyOf(target.username) !== meKey) toUser(target.username, 'dm', msg);
  });

  socket.on('dm:history', (withUser, ack) => {
    ack?.((db.dms[dmKey(me, String(withUser || ''))] || []).slice(-100));
  });

  /* ---------- Desafios ---------- */
  socket.on('challenge:send', ({ to, format, note }, ack) => {
    const target = db.users[keyOf(String(to || ''))];
    if (!target) return ack?.({ error: 'Jogador não encontrado.' });
    if (keyOf(target.username) === meKey) return ack?.({ error: 'Você não pode desafiar a si mesmo 😅' });
    const open = Object.values(db.challenges).find(
      (c) => ['pending', 'accepted', 'reported'].includes(c.status) &&
        [keyOf(c.from), keyOf(c.to)].sort().join('|') === dmKey(me, target.username)
    );
    if (open) return ack?.({ error: 'Já existe um desafio em aberto entre vocês dois.' });

    const c = {
      id: id(), from: me, to: target.username,
      format: FORMATS.includes(format) ? format : 'FT5',
      note: clean(note, 140), status: 'pending',
      createdAt: now(), updatedAt: now(), report: null, winner: null,
    };
    db.challenges[c.id] = c;
    save();
    sendChallenge(c);
    ack?.({ ok: true });
  });

  function getChallenge(cid, ack) {
    const c = db.challenges[cid];
    if (!c || (keyOf(c.from) !== meKey && keyOf(c.to) !== meKey)) {
      ack?.({ error: 'Desafio não encontrado.' });
      return null;
    }
    return c;
  }
  const touch = (c) => { c.updatedAt = now(); save(); sendChallenge(c); broadcastPresence(); };

  socket.on('challenge:respond', ({ id: cid, accept }, ack) => {
    const c = getChallenge(cid, ack);
    if (!c) return;
    if (keyOf(c.to) !== meKey || c.status !== 'pending') return ack?.({ error: 'Esse desafio não pode mais ser respondido.' });
    c.status = accept ? 'accepted' : 'declined';
    touch(c);
    ack?.({ ok: true });
  });

  socket.on('challenge:cancel', (cid, ack) => {
    const c = getChallenge(cid, ack);
    if (!c) return;
    if (!['pending', 'accepted'].includes(c.status)) return ack?.({ error: 'Não é possível cancelar agora.' });
    if (c.status === 'pending' && keyOf(c.from) !== meKey) return ack?.({ error: 'Só quem desafiou pode cancelar.' });
    c.status = 'cancelled';
    c.cancelledBy = me;
    touch(c);
    ack?.({ ok: true });
  });

  /** Um jogador informa o placar; o outro precisa confirmar. */
  socket.on('challenge:report', ({ id: cid, myScore, oppScore }, ack) => {
    const c = getChallenge(cid, ack);
    if (!c) return;
    if (c.status !== 'accepted') return ack?.({ error: 'Só é possível informar placar de lutas aceitas.' });
    const a = Math.max(0, Math.min(99, parseInt(myScore, 10) || 0));
    const b = Math.max(0, Math.min(99, parseInt(oppScore, 10) || 0));
    if (a === b) return ack?.({ error: 'Não existe empate — alguém tem que vencer! 🔥' });
    const opp = keyOf(c.from) === meKey ? c.to : c.from;
    c.report = { by: me, scores: { [me]: a, [opp]: b } };
    c.status = 'reported';
    touch(c);
    ack?.({ ok: true });
  });

  socket.on('challenge:confirm', ({ id: cid, agree }, ack) => {
    const c = getChallenge(cid, ack);
    if (!c) return;
    if (c.status !== 'reported' || keyOf(c.report.by) === meKey)
      return ack?.({ error: 'Aguardando o adversário confirmar.' });
    if (!agree) {
      c.status = 'accepted'; // volta para a luta e o placar pode ser informado de novo
      c.report = null;
      c.disputes = (c.disputes || 0) + 1;
      touch(c);
      return ack?.({ ok: true });
    }
    const [p1, p2] = [c.from, c.to];
    const s = c.report.scores;
    c.winner = s[p1] > s[p2] ? p1 : p2;
    const loser = c.winner === p1 ? p2 : p1;
    db.users[keyOf(c.winner)].wins = (db.users[keyOf(c.winner)].wins || 0) + 1;
    db.users[keyOf(loser)].losses = (db.users[keyOf(loser)].losses || 0) + 1;
    c.status = 'done';
    touch(c);
    io.emit('chat:global', {
      id: id(), system: true, at: now(),
      text: `🏆 ${c.winner} venceu ${loser} por ${s[c.winner]} x ${s[loser]} (${c.format})`,
    });
    ack?.({ ok: true });
  });

  socket.on('disconnect', () => {
    sockets.get(meKey)?.delete(socket.id);
    if (!sockets.get(meKey)?.size) sockets.delete(meKey);
    broadcastPresence();
  });
});

/* Expira desafios pendentes após 30 minutos */
setInterval(() => {
  const limit = now() - 30 * 60 * 1000;
  for (const c of Object.values(db.challenges)) {
    if (c.status === 'pending' && c.createdAt < limit) {
      c.status = 'expired';
      c.updatedAt = now();
      sendChallenge(c);
      save();
    }
  }
}, 60 * 1000);

initDB().then(() => {
  server.listen(PORT, () => {
    const nets = require('os').networkInterfaces();
    const lan = Object.values(nets).flat().find((n) => n && n.family === 'IPv4' && !n.internal)?.address;
    console.log(`\n  🥊 BEST FIGHTER rodando!`);
    console.log(`  ➜ Neste PC:        http://localhost:${PORT}`);
    if (lan) console.log(`  ➜ Na mesma Wi-Fi:  http://${lan}:${PORT}\n`);
  });
});
