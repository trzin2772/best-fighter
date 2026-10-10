/* =====================================================================
   BEST FIGHTER — cliente
   ===================================================================== */
(() => {
  'use strict';

  /* ---------------- Constantes ---------------- */
  const PLATFORM = {
    'android-ggpo': '📱 Android · GGPO',
    'pc-fightcade': '💻 PC · Fightcade 2',
    'pc-ggpo': '💻 PC · GGPO',
    outro: 'Outro',
  };
  const CONTROL = { joystick: '🕹️ Arcade stick', controle: '🎮 Controle', teclado: '⌨️ Teclado', touch: '📱 Touch' };
  const STATUS = {
    pending: 'AGUARDANDO', accepted: 'EM LUTA', reported: 'CONFIRMAR', done: 'FINAL',
    declined: 'RECUSADO', cancelled: 'CANCELADO', expired: 'EXPIROU',
  };
  const ACTIVE = ['pending', 'accepted', 'reported'];

  /* ---------------- Estado ---------------- */
  const S = {
    token: localStorage.getItem('bf_token'),
    me: null,
    players: new Map(),      // lower -> user
    global: [],
    dms: new Map(),          // lower -> msgs[]
    loadedDms: new Set(),
    convos: [],              // lower names (abas abertas)
    unread: new Map(),       // 'global' | lower -> n
    active: 'global',
    challenges: new Map(),
    filter: 'online',
    search: '',
    view: 'lobby',
    panel: 'chat',
  };
  let socket = null;

  /* ---------------- Utilidades ---------------- */
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const low = (s) => String(s || '').toLowerCase();
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const avatarUrl = (n) => `/img/avatars/${n || 1}.jpg`;
  const user = (name) => S.players.get(low(name)) || { username: name, avatar: 1, platform: 'outro', control: 'touch', status: 'offline' };
  const isMe = (name) => S.me && low(name) === low(S.me.username);
  const time = (t) => new Date(t).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  const day = (t) => new Date(t).toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: 'short' });
  const opponentOf = (c) => (isMe(c.from) ? c.to : c.from);

  function toast(text, type = '', ms = 4000) {
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.textContent = text;
    $('#toasts').appendChild(el);
    const kill = () => { el.classList.add('out'); setTimeout(() => el.remove(), 250); };
    el.onclick = kill;
    setTimeout(kill, ms);
  }

  /* Som de "moeda" estilo arcade (Web Audio, sem arquivos) */
  let audio;
  function beep(kind = 'coin') {
    try {
      audio ||= new (window.AudioContext || window.webkitAudioContext)();
      const notes = kind === 'fight' ? [392, 523, 659, 784] : kind === 'msg' ? [880] : [988, 1319];
      notes.forEach((f, i) => {
        const o = audio.createOscillator(), g = audio.createGain();
        o.type = 'square'; o.frequency.value = f;
        g.gain.setValueAtTime(0.06, audio.currentTime + i * 0.09);
        g.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + i * 0.09 + 0.12);
        o.connect(g).connect(audio.destination);
        o.start(audio.currentTime + i * 0.09);
        o.stop(audio.currentTime + i * 0.09 + 0.13);
      });
    } catch { /* sem áudio */ }
  }

  /* =====================================================================
     AUTENTICAÇÃO
     ===================================================================== */
  let authMode = 'login';
  $$('[data-auth]').forEach((b) => b.addEventListener('click', () => {
    authMode = b.dataset.auth;
    $$('[data-auth]').forEach((x) => x.classList.toggle('active', x === b));
    $('#auth').classList.toggle('is-register', authMode === 'register');
    $('#auth-submit .btn-label').textContent = authMode === 'login' ? 'Entrar na arena' : 'Criar lutador';
    $('#auth-password').autocomplete = authMode === 'login' ? 'current-password' : 'new-password';
    $('#auth-error').textContent = '';
  }));

  $('#auth-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('#auth-submit');
    btn.disabled = true;
    $('#auth-error').textContent = '';
    try {
      const body = {
        username: $('#auth-username').value.trim(),
        password: $('#auth-password').value,
        platform: $('#auth-platform').value,
        control: $('#auth-control').value,
      };
      const res = await fetch(`/api/${authMode}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Erro inesperado.');
      S.token = data.token;
      localStorage.setItem('bf_token', data.token);
      beep('coin');
      connect();
    } catch (err) {
      $('#auth-error').textContent = err.message;
    } finally {
      btn.disabled = false;
    }
  });

  function logout() {
    fetch('/api/logout', { method: 'POST', headers: { Authorization: S.token || '' } }).catch(() => {});
    localStorage.removeItem('bf_token');
    location.reload();
  }
  $('#btn-logout').addEventListener('click', logout);

  /* =====================================================================
     SOCKET
     ===================================================================== */
  function connect() {
    socket = io({ auth: { token: S.token } });

    socket.on('connect_error', (err) => {
      if (err.message === 'unauthorized') {
        localStorage.removeItem('bf_token');
        socket.close();
        $('#auth').classList.remove('hidden');
        $('#app').classList.add('hidden');
      }
    });

    socket.on('init', (d) => {
      S.me = d.me;
      setPlayers(d.players);
      S.global = d.globalChat;
      S.challenges = new Map(d.challenges.map((c) => [c.id, c]));
      d.conversations
        .sort((a, b) => (b.last?.at || 0) - (a.last?.at || 0))
        .slice(0, 8)
        .forEach((c) => { if (!S.convos.includes(low(c.with)) && !isMe(c.with)) S.convos.push(low(c.with)); });

      $('#auth').classList.add('hidden');
      $('#app').classList.remove('hidden');
      renderMe();
      renderProfileForm();
      renderPlayers();
      renderChat();
      renderChallenges();

      // Desafio pendente recebido enquanto estava fora
      const waiting = [...S.challenges.values()].find((c) => c.status === 'pending' && isMe(c.to));
      if (waiting) openIncoming(waiting);
    });

    socket.on('players', (list) => {
      setPlayers(list);
      renderPlayers();
      renderChatHead();
      renderChallenges();
    });

    socket.on('chat:global', (m) => {
      S.global.push(m);
      if (S.global.length > 300) S.global.shift();
      if (!(S.active === 'global' && chatVisible())) bumpUnread('global');
      if (S.active === 'global') appendMessage(m);
    });

    socket.on('dm', (m) => {
      const other = low(isMe(m.from) ? m.to : m.from);
      if (!S.dms.has(other)) S.dms.set(other, []);
      S.dms.get(other).push(m);
      if (!S.convos.includes(other)) S.convos.unshift(other);
      if (!isMe(m.from)) {
        if (!(S.active === other && chatVisible())) {
          bumpUnread(other);
          beep('msg');
          toast(`💬 ${m.from}: ${m.text.slice(0, 60)}`);
        }
      }
      if (S.active === other) appendMessage(m);
      renderChatTabs();
    });

    socket.on('challenge', onChallenge);
  }

  function setPlayers(list) {
    S.players = new Map(list.map((u) => [low(u.username), u]));
    if (S.me) S.me = S.players.get(low(S.me.username)) || S.me;
    $('#online-count').textContent = list.filter((u) => u.online).length;
    renderMe();
  }

  /* =====================================================================
     NAVEGAÇÃO
     ===================================================================== */
  function go(view, panel) {
    S.view = view;
    if (panel) S.panel = panel;
    $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${view}`));
    $$('.navlink').forEach((n) => n.classList.toggle('active', n.dataset.go === view));
    $('#view-lobby').dataset.panel = S.panel;
    $$('.bottomnav button').forEach((b) => b.classList.toggle('active',
      b.dataset.go === view && (view !== 'lobby' || b.dataset.panel === S.panel)));
    if (chatVisible()) clearUnread(S.active);
    if (view === 'lobby' && S.panel === 'challenges') $('#bn-ch-dot').classList.remove('on');
  }
  document.addEventListener('click', (e) => {
    const t = e.target.closest('[data-go]');
    if (!t) return;
    e.preventDefault();
    go(t.dataset.go, t.dataset.panel);
  });
  const isMobile = () => matchMedia('(max-width: 900px)').matches;
  const chatVisible = () => S.view === 'lobby' && (!isMobile() || S.panel === 'chat') && !document.hidden;
  document.addEventListener('visibilitychange', () => { if (chatVisible()) clearUnread(S.active); });

  /* =====================================================================
     TOPO / PERFIL
     ===================================================================== */
  function renderMe() {
    if (!S.me) return;
    $('#me-avatar').src = avatarUrl(S.me.avatar);
    $('#me-name').textContent = S.me.username;
    $('#profile-avatar-big').src = avatarUrl(S.me.avatar);
    $('#profile-name').textContent = S.me.username;
    const total = S.me.wins + S.me.losses;
    $('#stat-wins').textContent = S.me.wins;
    $('#stat-losses').textContent = S.me.losses;
    $('#stat-rate').textContent = total ? Math.round((S.me.wins / total) * 100) + '%' : '—';
  }

  let pickedAvatar = 1;
  function renderProfileForm() {
    const me = S.me;
    pickedAvatar = me.avatar;
    $('#avatar-picker').innerHTML = Array.from({ length: 8 }, (_, i) => i + 1).map((n) => `
      <button type="button" class="avatar-opt ${n === me.avatar ? 'selected' : ''}" data-avatar="${n}" id="avatar-opt-${n}" aria-label="Avatar ${n}">
        <img src="${avatarUrl(n)}" alt="" loading="lazy" />
      </button>`).join('');
    $('#pf-platform').value = me.platform;
    $('#pf-control').value = me.control;
    $('#pf-emulator').value = me.emulatorId || '';
    $('#pf-city').value = me.city || '';
    $('#pf-team').value = me.team || '';
    $('#pf-bio').value = me.bio || '';
  }
  $('#avatar-picker').addEventListener('click', (e) => {
    const b = e.target.closest('[data-avatar]');
    if (!b) return;
    pickedAvatar = Number(b.dataset.avatar);
    $$('.avatar-opt').forEach((x) => x.classList.toggle('selected', x === b));
    $('#profile-avatar-big').src = avatarUrl(pickedAvatar);
  });
  $('#profile-form').addEventListener('submit', (e) => {
    e.preventDefault();
    socket.emit('profile:update', {
      avatar: pickedAvatar,
      platform: $('#pf-platform').value,
      control: $('#pf-control').value,
      emulatorId: $('#pf-emulator').value,
      city: $('#pf-city').value,
      team: $('#pf-team').value,
      bio: $('#pf-bio').value,
    }, (r) => {
      if (r?.ok) { S.me = r.me; renderMe(); toast('✅ Perfil salvo!'); beep('coin'); }
    });
  });

  /* =====================================================================
     JOGADORES
     ===================================================================== */
  $('#player-search').addEventListener('input', (e) => { S.search = low(e.target.value); renderPlayers(); });
  $$('[data-filter]').forEach((b) => b.addEventListener('click', () => {
    S.filter = b.dataset.filter;
    $$('[data-filter]').forEach((x) => x.classList.toggle('active', x === b));
    renderPlayers();
  }));

  function renderPlayers() {
    const order = { lutando: 0, online: 1, offline: 2 };
    const list = [...S.players.values()]
      .filter((u) => S.filter === 'all' || u.online)
      .filter((u) => !S.search || low(u.username).includes(S.search) || low(u.city).includes(S.search))
      .sort((a, b) => (isMe(b.username) - isMe(a.username)) || (order[a.status] - order[b.status]) || a.username.localeCompare(b.username));

    $('#players-count').textContent = [...S.players.values()].filter((u) => u.online).length;
    $('#players-list').innerHTML = list.length ? list.map((u) => `
      <li class="player ${u.online ? '' : 'offline'}" data-player="${esc(u.username)}">
        <div class="avatar"><img src="${avatarUrl(u.avatar)}" alt="" loading="lazy" /><i class="status ${u.status}"></i></div>
        <div class="player-info">
          <div class="player-name">${esc(u.username)} ${isMe(u.username) ? '<span class="you">VOCÊ</span>' : ''}</div>
          <div class="player-meta">${u.status === 'lutando' ? '🔥 Em luta · ' : ''}${PLATFORM[u.platform] || ''} · ${u.wins}V ${u.losses}D</div>
        </div>
        ${isMe(u.username) ? '' : `
        <div class="player-actions">
          <button class="mini-btn" data-dm="${esc(u.username)}" title="Mensagem privada" aria-label="Mensagem para ${esc(u.username)}">💬</button>
          <button class="mini-btn" data-challenge="${esc(u.username)}" title="Desafiar" aria-label="Desafiar ${esc(u.username)}">⚔️</button>
        </div>`}
      </li>`).join('')
      : `<li class="empty"><b>🕹️</b>${S.filter === 'online' ? 'Ninguém online agora. Chame a galera do fliper!' : 'Nenhum lutador encontrado.'}</li>`;
  }

  document.addEventListener('click', (e) => {
    const dm = e.target.closest('[data-dm]');
    if (dm) { e.stopPropagation(); closeModal(); openDM(dm.dataset.dm); return; }
    const ch = e.target.closest('[data-challenge]');
    if (ch) { e.stopPropagation(); openChallengeModal(ch.dataset.challenge); return; }
    const p = e.target.closest('[data-player]');
    if (p) openPlayer(p.dataset.player);
  });

  /* =====================================================================
     CHAT
     ===================================================================== */
  function bumpUnread(key) {
    S.unread.set(key, (S.unread.get(key) || 0) + 1);
    renderChatTabs();
    updateTitle();
  }
  function clearUnread(key) {
    if (!S.unread.get(key)) return;
    S.unread.delete(key);
    renderChatTabs();
    updateTitle();
  }
  function updateTitle() {
    const n = [...S.unread.entries()].reduce((a, [k, v]) => a + (k === 'global' ? 0 : v), 0);
    const pendingCh = [...S.challenges.values()].filter((c) => c.status === 'pending' && isMe(c.to)).length;
    const total = n + pendingCh;
    document.title = (total ? `(${total}) ` : '') + 'Best Fighter — Comunidade KOF 2002';
    $('#bn-chat-dot').classList.toggle('on', S.unread.size > 0);
  }

  function renderChat() {
    renderChatTabs();
    renderChatHead();
    renderMessages();
  }

  function renderChatTabs() {
    const g = S.unread.get('global') || 0;
    $('#chat-tabs').innerHTML =
      `<button class="chat-tab ${S.active === 'global' ? 'active' : ''}" data-tab="global" id="chat-tab-global">🌐 Global${g ? `<span class="badge">${g > 99 ? '99+' : g}</span>` : ''}</button>` +
      S.convos.map((k) => {
        const u = user(k), n = S.unread.get(k) || 0;
        return `<button class="chat-tab ${S.active === k ? 'active' : ''}" data-tab="${esc(k)}">
          <img src="${avatarUrl(u.avatar)}" alt="" />${esc(u.username)}${n ? `<span class="badge">${n}</span>` : ''}
          <span class="x" data-closetab="${esc(k)}" title="Fechar">✕</span></button>`;
      }).join('');
  }

  $('#chat-tabs').addEventListener('click', (e) => {
    const x = e.target.closest('[data-closetab]');
    if (x) {
      S.convos = S.convos.filter((k) => k !== x.dataset.closetab);
      if (S.active === x.dataset.closetab) S.active = 'global';
      renderChat();
      return;
    }
    const t = e.target.closest('[data-tab]');
    if (t) setActiveChat(t.dataset.tab);
  });

  function setActiveChat(key) {
    S.active = key;
    if (key !== 'global' && !S.loadedDms.has(key)) {
      S.loadedDms.add(key);
      socket.emit('dm:history', key, (msgs) => {
        S.dms.set(key, msgs);
        if (S.active === key) renderMessages();
      });
    }
    clearUnread(key);
    renderChat();
    $('#chat-input').placeholder = key === 'global' ? 'Mande um salve para a galera…' : `Mensagem privada para ${user(key).username}…`;
    if (!isMobile()) $('#chat-input').focus();
  }

  function openDM(name) {
    const k = low(name);
    if (isMe(k)) return;
    if (!S.convos.includes(k)) S.convos.unshift(k);
    go('lobby', 'chat');
    setActiveChat(k);
  }

  function renderChatHead() {
    if (S.active === 'global') {
      const online = [...S.players.values()].filter((u) => u.online).length;
      $('#chat-head').innerHTML = `<div class="grow"><h3>🌐 Chat global</h3><small>${online} lutador(es) online · seja respeitoso, GG sempre</small></div>`;
    } else {
      const u = user(S.active);
      $('#chat-head').innerHTML = `
        <div class="avatar"><img src="${avatarUrl(u.avatar)}" alt="" /><i class="status ${u.status}"></i></div>
        <div class="grow"><h3>${esc(u.username)}</h3><small>${PLATFORM[u.platform] || ''} · ${CONTROL[u.control] || ''}</small></div>
        <button class="btn btn-fire btn-sm" data-challenge="${esc(u.username)}" id="chat-head-challenge">⚔️ Desafiar</button>`;
    }
  }

  const currentMsgs = () => (S.active === 'global' ? S.global : S.dms.get(S.active) || []);

  function messageHtml(m, prev) {
    if (m.system) return `<li class="msg system">${esc(m.text)}</li>`;
    let sep = '';
    if (!prev || new Date(prev.at).toDateString() !== new Date(m.at).toDateString()) sep = `<li class="day-sep">${day(m.at)}</li>`;
    const cont = !sep && prev && !prev.system && prev.from === m.from && m.at - prev.at < 5 * 60 * 1000;
    const u = user(m.from);
    return `${sep}<li class="msg ${cont ? 'cont' : ''} ${isMe(m.from) ? 'mine' : ''}">
      <img src="${avatarUrl(u.avatar)}" alt="" data-player="${esc(m.from)}" />
      <div class="msg-body">
        ${cont ? '' : `<div class="msg-top"><span class="msg-author" data-player="${esc(m.from)}">${esc(m.from)}</span><span class="msg-time">${time(m.at)}</span></div>`}
        <div class="msg-text">${esc(m.text)}</div>
      </div></li>`;
  }

  function renderMessages() {
    const msgs = currentMsgs();
    const box = $('#messages');
    box.innerHTML = msgs.length
      ? msgs.map((m, i) => messageHtml(m, msgs[i - 1])).join('')
      : `<li class="empty"><b>${S.active === 'global' ? '🔥' : '🤝'}</b>${S.active === 'global' ? 'Seja o primeiro a mandar um salve!' : 'Comece a conversa e marque a luta.'}</li>`;
    box.scrollTop = box.scrollHeight;
  }

  function appendMessage(m) {
    const box = $('#messages');
    const msgs = currentMsgs();
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 140;
    if (msgs.length === 1) return renderMessages();
    box.insertAdjacentHTML('beforeend', messageHtml(m, msgs[msgs.length - 2]));
    if (nearBottom || isMe(m.from)) box.scrollTop = box.scrollHeight;
  }

  $('#chat-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $('#chat-input');
    const text = input.value.trim();
    if (!text) return;
    if (S.active === 'global') socket.emit('chat:global', text);
    else socket.emit('dm:send', { to: S.active, text });
    input.value = '';
  });

  /* =====================================================================
     DESAFIOS
     ===================================================================== */
  function onChallenge(c) {
    const prev = S.challenges.get(c.id);
    S.challenges.set(c.id, c);
    renderChallenges();
    updateTitle();
    if (prev?.status === c.status) return;

    const opp = opponentOf(c);
    if (c.status === 'pending' && isMe(c.to)) {
      openIncoming(c);
    } else if (c.status === 'accepted' && (!prev || prev.status === 'pending')) {
      closeModal();
      showVS(c);
    } else if (c.status === 'declined' && isMe(c.from)) {
      toast(`❌ ${opp} recusou seu desafio.`, 'err');
    } else if (c.status === 'cancelled' && !isMe(c.cancelledBy)) {
      toast(`🚫 ${c.cancelledBy} cancelou o desafio.`, 'err');
      if (isMe(c.to)) closeModal();
    } else if (c.status === 'reported' && !isMe(c.report.by)) {
      beep('coin');
      toast(`📋 ${opp} informou o placar. Confirme em Desafios!`, 'fire', 6000);
      $('#bn-ch-dot').classList.add('on');
    } else if (c.status === 'accepted' && prev?.status === 'reported' && isMe(prev.report?.by)) {
      toast(`⚠️ ${opp} contestou o placar. Conversem e informem de novo.`, 'err', 6000);
    } else if (c.status === 'done') {
      const won = isMe(c.winner);
      beep(won ? 'fight' : 'msg');
      toast(won ? `🏆 Vitória registrada contra ${opp}!` : `💀 Derrota registrada. Volta pro treino!`, won ? 'fire' : '', 6000);
    } else if (c.status === 'expired' && isMe(c.to)) {
      closeModal();
    }
  }

  function challengeHtml(c) {
    const a = user(c.from), b = user(c.to);
    const incoming = isMe(c.to);
    const opp = user(opponentOf(c));
    const scores = c.report?.scores || {};
    const showScore = c.status === 'reported' || c.status === 'done';
    const sc = (name) => (showScore ? `<span class="score">${scores[name] ?? ''}</span>` : '');

    let body = '';
    if (c.status === 'pending') {
      body = incoming
        ? `<div class="ch-actions">
             <button class="btn btn-fire btn-sm" data-act="accept" data-id="${c.id}">✔ Aceitar</button>
             <button class="btn btn-danger btn-sm" data-act="decline" data-id="${c.id}">✕ Recusar</button></div>`
        : `<div class="ch-actions"><button class="btn btn-ghost btn-sm" data-act="cancel" data-id="${c.id}">Cancelar desafio</button></div>`;
    } else if (c.status === 'accepted') {
      body = `${connectHtml(c, opp)}
        <div class="ch-actions">
          <button class="btn btn-fire btn-sm" data-act="report" data-id="${c.id}">📋 Informar placar</button>
          <button class="btn btn-ghost btn-sm" data-dm="${esc(opp.username)}">💬 Chat</button>
          <button class="btn btn-danger btn-sm" data-act="cancel" data-id="${c.id}" title="Cancelar">✕</button>
        </div>`;
    } else if (c.status === 'reported') {
      body = isMe(c.report.by)
        ? `<div class="ch-meta">⏳ Aguardando ${esc(opp.username)} confirmar o placar…</div>`
        : `<div class="ch-meta">${esc(c.report.by)} informou o placar acima. Está certo?</div>
           <div class="ch-actions">
             <button class="btn btn-fire btn-sm" data-act="confirm" data-id="${c.id}">✔ Confirmar</button>
             <button class="btn btn-danger btn-sm" data-act="dispute" data-id="${c.id}">✕ Contestar</button></div>`;
    }

    return `<article class="ch ${c.status} ${incoming ? 'incoming' : ''}">
      <div class="ch-vs">
        <div class="ch-p"><img src="${avatarUrl(a.avatar)}" alt="" /><b data-player="${esc(a.username)}">${esc(a.username)}</b>${sc(a.username)}</div>
        <div class="ch-mid">VS</div>
        <div class="ch-p"><img src="${avatarUrl(b.avatar)}" alt="" /><b data-player="${esc(b.username)}">${esc(b.username)}</b>${sc(b.username)}</div>
      </div>
      <div class="ch-meta">
        <span class="tag st-${c.status}">${STATUS[c.status]}</span>
        <span class="tag">${c.format}</span>
        ${c.status === 'done' ? `<span>🏆 ${esc(c.winner)}</span>` : `<span>${time(c.createdAt)}</span>`}
      </div>
      ${c.note ? `<p class="ch-note">“${esc(c.note)}”</p>` : ''}
      ${body}
    </article>`;
  }

  function connectHtml(c, opp) {
    const me = S.me;
    const same = me.platform === opp.platform;
    return `<div class="connect">
      ${same
        ? `<div class="ok">✅ Os dois jogam em ${PLATFORM[me.platform]}</div>`
        : `<div class="warn">⚠️ Você: ${PLATFORM[me.platform]} · ${esc(opp.username)}: ${PLATFORM[opp.platform]}. Combinem de usar o mesmo app.</div>`}
      <div>🎮 Ache no emulador: <code>${esc(opp.emulatorId || opp.username)}</code>${opp.emulatorId ? '' : ' <small class="muted">(ID não informado, pergunte no chat)</small>'}</div>
      <div>📨 Quem envia o convite: <b>${esc(c.from)}</b> · Sala: <b>KOF 2002</b></div>
    </div>`;
  }

  function renderChallenges() {
    const all = [...S.challenges.values()].sort((a, b) => b.updatedAt - a.updatedAt);
    const active = all.filter((c) => ACTIVE.includes(c.status));
    const past = all.filter((c) => !ACTIVE.includes(c.status)).slice(0, 15);
    $('#challenges-count').textContent = active.length;
    const needsMe = active.some((c) => (c.status === 'pending' && isMe(c.to)) || (c.status === 'reported' && !isMe(c.report.by)));
    if (needsMe && !(S.view === 'lobby' && S.panel === 'challenges')) $('#bn-ch-dot').classList.add('on');

    $('#challenges-list').innerHTML =
      (active.length ? `<p class="ch-section">Em andamento</p>${active.map(challengeHtml).join('')}`
        : `<div class="empty"><b>⚔️</b>Nenhum desafio em aberto.<br/>Clique em ⚔️ ao lado de um lutador para desafiar!</div>`) +
      (past.length ? `<p class="ch-section">Histórico</p>${past.map(challengeHtml).join('')}` : '');
  }

  const ackErr = (r) => { if (r?.error) toast(r.error, 'err'); };
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const c = S.challenges.get(b.dataset.id);
    if (!c) return;
    switch (b.dataset.act) {
      case 'accept': socket.emit('challenge:respond', { id: c.id, accept: true }, ackErr); break;
      case 'decline': socket.emit('challenge:respond', { id: c.id, accept: false }, ackErr); closeModal(); break;
      case 'cancel': if (confirm('Cancelar este desafio?')) socket.emit('challenge:cancel', c.id, ackErr); break;
      case 'report': openReport(c); break;
      case 'confirm': socket.emit('challenge:confirm', { id: c.id, agree: true }, ackErr); break;
      case 'dispute': socket.emit('challenge:confirm', { id: c.id, agree: false }, ackErr); break;
    }
  });

  /* =====================================================================
     MODAIS
     ===================================================================== */
  function openModal(html, cls = '') {
    $('#modal-box').className = `modal-box card ${cls}`;
    $('#modal-box').innerHTML = html;
    $('#modal').classList.remove('hidden');
  }
  function closeModal() { $('#modal').classList.add('hidden'); }
  $('#modal').addEventListener('click', (e) => { if (e.target.closest('[data-close]')) closeModal(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

  function openPlayer(name) {
    const u = user(name);
    const total = u.wins + u.losses;
    openModal(`
      <div class="pp-head">
        <img src="${avatarUrl(u.avatar)}" alt="" />
        <div><h3>${esc(u.username)}</h3>
          <span class="tag st-${u.status === 'lutando' ? 'accepted' : u.online ? 'done' : 'cancelled'}">${u.status.toUpperCase()}</span></div>
      </div>
      ${u.bio ? `<p class="pp-bio">“${esc(u.bio)}”</p>` : ''}
      <div class="pp-rows">
        <div class="pp-row"><span>Plataforma</span><b>${PLATFORM[u.platform] || '—'}</b></div>
        <div class="pp-row"><span>Controle</span><b>${CONTROL[u.control] || '—'}</b></div>
        <div class="pp-row"><span>Nome no emulador</span><b>${esc(u.emulatorId || '—')}</b></div>
        <div class="pp-row"><span>Time</span><b>${esc(u.team || '—')}</b></div>
        <div class="pp-row"><span>Cidade / Fliper</span><b>${esc(u.city || '—')}</b></div>
        <div class="pp-row"><span>Retrospecto</span><b>${u.wins}V · ${u.losses}D${total ? ` · ${Math.round((u.wins / total) * 100)}%` : ''}</b></div>
      </div>
      <div class="modal-actions">
        ${isMe(u.username)
          ? `<button class="btn btn-ghost" data-go="profile" data-close id="pp-edit">Editar perfil</button>`
          : `<button class="btn btn-ghost" data-dm="${esc(u.username)}" id="pp-dm">💬 Mensagem</button>
             <button class="btn btn-fire" data-challenge="${esc(u.username)}" id="pp-challenge">⚔️ Desafiar</button>`}
      </div>`);
  }

  function openChallengeModal(name) {
    const u = user(name);
    let format = 'FT5';
    openModal(`
      <h3>⚔️ Desafiar ${esc(u.username)}</h3>
      ${u.online ? '' : '<p class="form-error">Este lutador está offline. Ele verá o desafio quando entrar (expira em 30 min).</p>'}
      <p class="muted" style="margin-bottom:10px">Formato da luta (primeiro a X vitórias)</p>
      <div class="format-pick">${['FT3', 'FT5', 'FT7', 'FT10'].map((f) => `<button type="button" data-format="${f}" class="${f === format ? 'selected' : ''}">${f}</button>`).join('')}</div>
      <label class="field"><span>Recado (opcional)</span><input id="ch-note" maxlength="140" placeholder="ex: Bora uma FT5? Hoje não tem perdão!" /></label>
      <div class="modal-actions">
        <button class="btn btn-ghost" data-close>Voltar</button>
        <button class="btn btn-fire" id="ch-send">Enviar desafio</button>
      </div>`);
    $$('[data-format]').forEach((b) => b.addEventListener('click', () => {
      format = b.dataset.format;
      $$('[data-format]').forEach((x) => x.classList.toggle('selected', x === b));
    }));
    $('#ch-send').addEventListener('click', () => {
      socket.emit('challenge:send', { to: u.username, format, note: $('#ch-note').value }, (r) => {
        if (r?.error) return toast(r.error, 'err');
        closeModal();
        toast(`⚔️ Desafio enviado para ${u.username}!`, 'fire');
        beep('coin');
      });
    });
  }

  function openIncoming(c) {
    const u = user(c.from);
    beep('fight');
    openModal(`
      <div class="incoming-box">
        <p class="alert-title">HERE COMES A NEW CHALLENGER!</p>
        <img src="${avatarUrl(u.avatar)}" alt="" />
        <h3>${esc(u.username)}</h3>
        <p class="muted">${PLATFORM[u.platform] || ''} · ${CONTROL[u.control] || ''} · ${u.wins}V ${u.losses}D</p>
        <p style="margin:12px 0"><span class="tag">${c.format}</span></p>
        ${c.note ? `<p class="ch-note" style="margin-bottom:12px">“${esc(c.note)}”</p>` : ''}
        ${S.me.platform !== u.platform ? `<p class="form-error">⚠️ Ele joga em ${PLATFORM[u.platform]} e você em ${PLATFORM[S.me.platform]}.</p>` : ''}
        <div class="modal-actions">
          <button class="btn btn-danger" data-act="decline" data-id="${c.id}" id="incoming-decline">✕ Recusar</button>
          <button class="btn btn-fire" data-act="accept" data-id="${c.id}" id="incoming-accept">✔ Aceitar</button>
        </div>
      </div>`, 'incoming-box');
  }

  function openReport(c) {
    const opp = opponentOf(c);
    openModal(`
      <h3>📋 Placar final · ${c.format}</h3>
      <p class="muted" style="margin-bottom:14px">Informe o resultado. ${esc(opp)} precisa confirmar para valer.</p>
      <div class="score-row">
        <label><span>Você</span><input id="sc-me" type="number" min="0" max="99" value="0" inputmode="numeric" /></label>
        <span class="x">X</span>
        <label><span>${esc(opp)}</span><input id="sc-opp" type="number" min="0" max="99" value="0" inputmode="numeric" /></label>
      </div>
      <div class="modal-actions">
        <button class="btn btn-ghost" data-close>Voltar</button>
        <button class="btn btn-fire" id="sc-send">Enviar placar</button>
      </div>`);
    $('#sc-send').addEventListener('click', () => {
      socket.emit('challenge:report', { id: c.id, myScore: $('#sc-me').value, oppScore: $('#sc-opp').value }, (r) => {
        if (r?.error) return toast(r.error, 'err');
        closeModal();
        toast('📋 Placar enviado! Aguardando confirmação.');
      });
    });
  }

  /* Tela VS ao aceitar o desafio */
  function showVS(c) {
    const a = user(c.from), b = user(c.to);
    $('#vs-img-a').src = avatarUrl(a.avatar);
    $('#vs-img-b').src = avatarUrl(b.avatar);
    $('#vs-name-a').textContent = a.username;
    $('#vs-name-b').textContent = b.username;
    const vs = $('#vs-screen');
    vs.classList.remove('hidden');
    // reinicia animações
    vs.querySelectorAll('*').forEach((el) => { el.style.animation = 'none'; void el.offsetWidth; el.style.animation = ''; });
    beep('fight');
    const hide = () => { vs.classList.add('hidden'); go('lobby', 'challenges'); };
    vs.onclick = hide;
    setTimeout(hide, 3200);
  }

  /* ---------------- Início ---------------- */
  if (S.token) connect();
})();
