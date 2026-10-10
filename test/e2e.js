// Teste E2E do backend: 2 jogadores, chat, DM, desafio completo.
const { io } = require('socket.io-client');
const URL = 'http://localhost:3000';
const sfx = Date.now().toString().slice(-5);
const post = (p, b) => fetch(URL + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then((r) => r.json());
const wait = (s, ev, pred = () => true) => new Promise((res) => { const h = (d) => { if (pred(d)) { s.off(ev, h); res(d); } }; s.on(ev, h); });
const emit = (s, ev, d) => new Promise((res) => s.emit(ev, d, res));
const ok = (cond, msg) => { console.log((cond ? 'PASS ' : 'FAIL ') + msg); if (!cond) process.exitCode = 1; };

(async () => {
  const A = 'Kyo' + sfx, B = 'Iori' + sfx;
  const ta = (await post('/api/register', { username: A, password: '123456', platform: 'android-ggpo' })).token;
  const tb = (await post('/api/register', { username: B, password: '123456', platform: 'pc-fightcade' })).token;
  ok(ta && tb, 'cadastro de 2 jogadores');
  ok((await post('/api/login', { username: A, password: 'errada' })).error, 'login com senha errada é recusado');
  ok((await post('/api/register', { username: A, password: '123456' })).error, 'nome duplicado é recusado');

  const sa = io(URL, { auth: { token: ta } }), sb = io(URL, { auth: { token: tb } });
  await Promise.all([wait(sa, 'init'), wait(sb, 'init')]);
  ok(true, 'conexão em tempo real');

  const g = wait(sb, 'chat:global', (m) => m.from === A);
  sa.emit('chat:global', 'Fala galera do fliper!');
  ok((await g).text === 'Fala galera do fliper!', 'chat global entregue');

  await new Promise((r) => setTimeout(r, 700));
  const dm = wait(sa, 'dm', (m) => m.from === B);
  sb.emit('dm:send', { to: A, text: 'GG!' });
  ok((await dm).text === 'GG!', 'mensagem privada entregue');

  const inc = wait(sa, 'challenge', (c) => c.status === 'pending');
  const r1 = await emit(sb, 'challenge:send', { to: A, format: 'FT5', note: 'Bora!' });
  ok(r1.ok, 'desafio enviado');
  const c = await inc;
  ok(c.from === B && c.format === 'FT5', 'desafiado recebe o desafio');
  ok((await emit(sb, 'challenge:send', { to: A })).error, 'desafio duplicado é bloqueado');

  const acc = wait(sb, 'challenge', (x) => x.status === 'accepted');
  await emit(sa, 'challenge:respond', { id: c.id, accept: true });
  ok(!!(await acc), 'desafio aceito e notificado');

  ok((await emit(sa, 'challenge:report', { id: c.id, myScore: 3, oppScore: 3 })).error, 'empate é recusado');
  const rep = wait(sb, 'challenge', (x) => x.status === 'reported');
  await emit(sa, 'challenge:report', { id: c.id, myScore: 5, oppScore: 3 });
  await rep;
  ok((await emit(sa, 'challenge:confirm', { id: c.id, agree: true })).error, 'quem reportou não pode confirmar');
  const sys = wait(sa, 'chat:global', (m) => m.system);
  const done = wait(sa, 'challenge', (x) => x.status === 'done');
  const plP = wait(sa, 'players', (l) => l.find((u) => u.username === A)?.wins === 1);
  await emit(sb, 'challenge:confirm', { id: c.id, agree: true });
  const fin = await done;
  ok(fin.winner === A, 'vencedor correto');
  console.log('      sistema: ' + (await sys).text);

  const pl = await plP;
  const ua = pl.find((u) => u.username === A), ub = pl.find((u) => u.username === B);
  ok(ua.wins === 1 && ub.losses === 1, 'vitória/derrota contabilizadas');

  const prof = await emit(sa, 'profile:update', { avatar: 3, platform: 'android-ggpo', control: 'joystick', emulatorId: 'kyo_fc', team: 'Kyo, Benimaru, Daimon' });
  ok(prof.me.emulatorId === 'kyo_fc' && prof.me.avatar === 3, 'perfil atualizado');

  sa.close(); sb.close();
})().catch((e) => { console.error(e); process.exitCode = 1; });
