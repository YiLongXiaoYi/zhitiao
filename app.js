'use strict';

/* ================================================================
 * 小纸条 · 网页版
 * 连接层用 WebRTC（PeerJS 负责信令），两端直连，消息不经服务器。
 * ================================================================ */

const ROOM_PREFIX = 'zhitiao1v1-';
const CONNECT_TIMEOUT = 20000;
const BURN_SECONDS = 10;

/* STUN：PeerJS 默认用 Google 的，国内基本不可达，这里换成可用的几个 */
const ICE_CONFIG = {
  iceServers: [
    { urls: ['stun:stun.miwifi.com:3478', 'stun:stun.chat.bilibili.com:3478'] },
    { urls: 'stun:stun.l.google.com:19302' },
  ],
  iceCandidatePoolSize: 4,
};

/* ---------------------------------------------------------------- 元素 */
const el = {
  home: document.getElementById('screen-home'),
  waiting: document.getElementById('screen-waiting'),
  chat: document.getElementById('screen-chat'),
  status: document.getElementById('statusbar'),
  waitCode: document.getElementById('wait-code'),
  waitStatus: document.getElementById('wait-status'),
  homeHint: document.getElementById('home-hint'),
  messages: document.getElementById('messages'),
  typing: document.getElementById('typing'),
  input: document.getElementById('input'),
  burn: document.getElementById('burn'),
  btnHost: document.getElementById('btn-host'),
  btnCopy: document.getElementById('btn-copy'),
  btnCancel: document.getElementById('btn-cancel'),
  formJoin: document.getElementById('form-join'),
  joinCode: document.getElementById('join-code'),
  joinName: document.getElementById('join-name'),
  hostName: document.getElementById('host-name'),
  formSend: document.getElementById('form-send'),
  toast: document.getElementById('toast'),
};

/* ---------------------------------------------------------------- 状态 */
const chat = ChatCore.createChat({ burnSeconds: BURN_SECONDS });
const ui = {
  screen: 'home', // home | waiting | chat
  roomCode: '',
  role: '', // host | guest
  connected: false,
  peerName: '',
  connecting: false,
};

let peer = null;
let conn = null;
let burnTimers = new Map();
let typingTimer = null;
let toastTimer = null;
let lastTyping = 0;

/* ---------------------------------------------------------------- 小工具 */
function toast(text) {
  el.toast.textContent = text;
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.toast.hidden = true), 3200);
}

const pad = (n) => String(n).padStart(2, '0');
const clock = (ts) => {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

function randomCode() {
  return String(Math.floor(1000 + Math.random() * 9000));
}

function myName() {
  const raw = ui.role === 'host'
    ? (el.hostName && el.hostName.value) || ''
    : (el.joinName && el.joinName.value) || '';
  const name = raw.trim();
  if (name) return name;
  return ui.role === 'host' ? '摆桌的人' : '对面的朋友';
}

/* ---------------------------------------------------------------- 屏幕切换 */
function setScreen(name) {
  ui.screen = name;
  el.home.hidden = name !== 'home';
  el.waiting.hidden = name !== 'waiting';
  el.chat.hidden = name !== 'chat';
  renderStatus();
  if (name === 'chat') requestAnimationFrame(() => autosize());
}

function renderStatus() {
  el.status.innerHTML = '';
  if (ui.screen === 'chat') {
    const dot = document.createElement('span');
    dot.className = 'dot ' + (ui.connected ? 'on' : 'off');
    const b = document.createElement('b');
    b.textContent = ui.peerName || '对方';
    const text = document.createElement('span');
    text.textContent = ui.connected ? ' 在线' : ' 已断开';
    const btn = document.createElement('button');
    btn.className = 'leave';
    btn.textContent = '离开';
    btn.onclick = () => location.reload();
    el.status.append(dot, b, text, btn);
    return;
  }
  if (ui.screen === 'waiting') {
    const dot = document.createElement('span');
    dot.className = 'dot on';
    const text = document.createElement('span');
    text.textContent = `房间号 ${ui.roomCode} · 等对方入座`;
    el.status.append(dot, text);
  }
}

/* ---------------------------------------------------------------- 渲染消息 */
const nodes = new Map();

function render() {
  if (ui.screen !== 'chat') return;
  const list = chat.messages();
  const alive = new Set(list.map((m) => m.id));

  for (const [id, node] of nodes) {
    if (!alive.has(id)) {
      node.remove();
      nodes.delete(id);
      clearTimeout(burnTimers.get(id));
      burnTimers.delete(id);
    }
  }

  const nearBottom = el.messages.scrollHeight - el.messages.scrollTop - el.messages.clientHeight < 90;

  for (const m of list) {
    let node = nodes.get(m.id);
    if (!node) {
      node = createNode(m);
      node.classList.add('arrive');
      el.messages.appendChild(node);
      nodes.set(m.id, node);
      if (m.side === 'peer' && m.burn) armBurn(m.id);
    } else {
      const st = node.querySelector('.state');
      if (st) {
        st.textContent = statusText(m);
        st.classList.toggle('failed', m.status === 'failed');
      }
    }
  }

  if (nearBottom) el.messages.scrollTop = el.messages.scrollHeight;
  reportSeen();
}

function statusText(m) {
  if (m.side !== 'me') return '';
  if (m.status === 'read') return '已读';
  if (m.status === 'delivered') return '已送达';
  if (m.status === 'failed') return '未送达';
  return '递出中';
}

function createNode(m) {
  const wrap = document.createElement('div');
  wrap.className = 'msg ' + (m.side === 'me' ? 'me' : m.side === 'peer' ? 'peer' : 'system');

  const note = document.createElement('div');
  note.className = 'note' + (m.burn ? ' burn-note' : '');

  const text = document.createElement('div');
  text.textContent = m.text;
  note.appendChild(text);

  if (m.side !== 'system') {
    const meta = document.createElement('div');
    meta.className = 'meta';
    const time = document.createElement('span');
    time.textContent = clock(m.ts);
    const st = document.createElement('span');
    st.className = 'state';
    st.textContent = statusText(m);
    meta.append(time, st);
    note.appendChild(meta);
  }

  wrap.appendChild(note);
  return wrap;
}

/* ---------------------------------------------------------------- 已读 / 焚毁 */
let seenBusy = false;

function reportSeen() {
  if (!ui.connected || document.hidden || seenBusy) return;
  const ids = chat.takeSeenIds();
  if (!ids.length) return;
  seenBusy = true;
  send(ChatCore.pack('seen', { ids }));
  setTimeout(() => (seenBusy = false), 300);
}

function armBurn(id) {
  if (burnTimers.has(id)) return;
  const timer = setTimeout(() => {
    burnTimers.delete(id);
    const node = nodes.get(id);
    if (node) node.querySelector('.note')?.classList.add('burning');
    setTimeout(() => {
      node?.remove();
      nodes.delete(id);
    }, 620);
    chat.burn(id);
    send(ChatCore.pack('burn', { id }));
  }, BURN_SECONDS * 1000);
  burnTimers.set(id, timer);
}

/* ---------------------------------------------------------------- 连接层 */
function send(payload) {
  if (!conn || !conn.open) return false;
  try {
    conn.send(payload);
    return true;
  } catch {
    return false;
  }
}

function newPeer(id) {
  return new Peer(id, { config: ICE_CONFIG, debug: 0 });
}

function wireConnection(connection) {
  conn = connection;

  conn.on('open', () => {
    ui.connected = true;
    setScreen('chat');
    send(ChatCore.pack('hello', { name: myName() }));
    chat.addSystem(`已连上，开始递纸条吧`);
    render();
    renderStatus();
    el.input.focus();
  });

  conn.on('data', (raw) => {
    const msg = ChatCore.parse(raw);
    if (!msg) return;

    if (msg.t === 'hello') {
      ui.peerName = String(msg.name || '对方').slice(0, 16);
      chat.setPeerName(ui.peerName);
      renderStatus();
      return;
    }

    if (msg.t === 'msg') {
      const got = chat.receive(msg);
      if (got) {
        send(ChatCore.pack('ack', { id: got.id }));
        render();
      }
      return;
    }

    if (msg.t === 'ack') {
      if (chat.onAck(msg.id)) render();
      return;
    }

    if (msg.t === 'seen') {
      if (chat.onSeen(msg.ids)) render();
      return;
    }

    if (msg.t === 'burn') {
      const node = nodes.get(msg.id);
      if (node) node.querySelector('.note')?.classList.add('burning');
      setTimeout(() => {
        node?.remove();
        nodes.delete(msg.id);
      }, 620);
      clearTimeout(burnTimers.get(msg.id));
      burnTimers.delete(msg.id);
      chat.burn(msg.id);
      return;
    }

    if (msg.t === 'typing') {
      el.typing.hidden = false;
      clearTimeout(typingTimer);
      typingTimer = setTimeout(() => (el.typing.hidden = true), 2600);
    }
  });

  conn.on('close', () => {
    ui.connected = false;
    chat.failPending();
    chat.addSystem('对方断开了');
    render();
    renderStatus();
    toast('连接断开了。刷新页面可以重新开始。');
    el.typing.hidden = true;
  });

  conn.on('error', (err) => {
    console.warn('connection error', err);
  });
}

/* ---------------------------------------------------------------- 主人：摆桌 */
let hostAttempts = 0;

function startHosting() {
  if (ui.connecting) return;
  ui.connecting = true;
  ui.role = 'host';
  el.btnHost.disabled = true;

  const code = randomCode();
  ui.roomCode = code;
  el.waitCode.textContent = code;
  el.waitStatus.textContent = '正在连接服务器…';
  setScreen('waiting');

  peer = newPeer(ROOM_PREFIX + code);

  peer.on('open', () => {
    ui.connecting = false;
    el.btnHost.disabled = false;
    el.waitStatus.textContent = '等待对方入座…';
  });

  peer.on('connection', (incoming) => {
    if (conn && conn.open) {
      try {
        incoming.close();
      } catch {}
      return;
    }
    wireConnection(incoming);
  });

  peer.on('error', (err) => {
    ui.connecting = false;
    el.btnHost.disabled = false;
    console.warn('peer error', err.type, err.message);

    if (err.type === 'unavailable-id' && hostAttempts < 5) {
      // 房间号被占了，换一个
      hostAttempts += 1;
      try {
        peer.destroy();
      } catch {}
      startHosting();
      return;
    }
    if (err.type === 'network' || err.type === 'server-error' || err.type === 'socket-error') {
      el.waitStatus.textContent = '连不上信令服务器，换个网络再试';
      toast('连不上信令服务器。可能是网络屏蔽，试试手机流量。');
      return;
    }
    el.waitStatus.textContent = '出错了：' + (err.type || '');
    toast('出错了：' + (err.message || err.type || '未知'));
  });
}

/* ---------------------------------------------------------------- 访客：加入 */
function joinRoom(code, name) {
  if (ui.connecting) return;
  ui.connecting = true;
  ui.role = 'guest';
  ui.roomCode = code;
  el.joinName.value = name || el.joinName.value;

  const btn = el.formJoin.querySelector('button');
  btn.disabled = true;
  btn.textContent = '连接中…';

  peer = newPeer(undefined);

  const finish = (text) => {
    ui.connecting = false;
    btn.disabled = false;
    btn.textContent = '入　座';
    if (text) toast(text);
  };

  let opened = false;

  peer.on('open', () => {
    const target = ROOM_PREFIX + code;
    const connection = peer.connect(target, { reliable: true, serialization: 'json' });
    wireConnection(connection);

    setTimeout(() => {
      if (!conn || !conn.open) {
        if (opened) return;
        finish('连不上（可能对方已经关掉了，或者网络禁了 P2P）');
        try {
          peer.destroy();
        } catch {}
      }
    }, CONNECT_TIMEOUT);

    connection.on('open', () => {
      opened = true;
      finish();
    });
  });

  peer.on('error', (err) => {
    console.warn('peer error', err.type, err.message);
    if (err.type === 'peer-unavailable') {
      finish('房间号不对，或者对方的桌子已经收了');
      return;
    }
    finish('连接失败：' + (err.type || err.message || '未知'));
  });
}

/* ---------------------------------------------------------------- 交互 */
el.btnHost.addEventListener('click', () => startHosting());

el.formJoin.addEventListener('submit', (e) => {
  e.preventDefault();
  const code = (el.joinCode.value || '').trim();
  if (!/^\d{4}$/.test(code)) {
    toast('房间号是 4 位数字');
    return;
  }
  joinRoom(code, el.joinName.value);
});

el.btnCancel.addEventListener('click', () => location.reload());

el.btnCopy.addEventListener('click', async () => {
  const text = `小纸条房间号：${ui.roomCode}`;
  try {
    await navigator.clipboard.writeText(text);
    toast('房间号已复制');
  } catch {
    toast(text);
  }
});

el.formSend.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = el.input.value.trim();
  if (!text) return;
  if (!ui.connected) {
    toast('还没连上对方');
    return;
  }
  const r = chat.addOutgoing(text, el.burn.checked);
  if (!r.ok) {
    toast(r.error);
    return;
  }
  send(ChatCore.pack('msg', {
    id: r.message.id,
    text: r.message.text,
    ts: r.message.ts,
    burn: r.message.burn,
  }));
  el.input.value = '';
  autosize();
  el.input.focus();
  render();
});

function autosize() {
  el.input.style.height = 'auto';
  const h = el.input.scrollHeight;
  el.input.style.height = Math.min(h, 132) + 'px';
  // 内容够放就不显示滚动条（Windows 上会露出一对上下箭头，很难看）
  el.input.style.overflowY = h > 132 ? 'auto' : 'hidden';
}

el.input.addEventListener('input', () => {
  autosize();
  const now = Date.now();
  if (now - lastTyping > 1500 && ui.connected) {
    lastTyping = now;
    send(ChatCore.pack('typing'));
  }
});

el.input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    el.formSend.requestSubmit();
  }
});

window.addEventListener('beforeunload', () => {
  try {
    peer && peer.destroy();
  } catch {}
});

setScreen('home');
autosize();
