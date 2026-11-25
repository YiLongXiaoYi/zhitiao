/**
 * 小纸条 · 网页版 —— 纯逻辑层（不碰 DOM，不碰网络）
 *
 * 之所以把这部分单独拆出来：两个人之间那条链路的正确性（送达、已读、焚毁、
 * 断线重发）最容易出错，而它不需要浏览器就能测。
 *
 * 既能被 <script> 直接加载（挂到 window.ChatCore），也能被 Node require。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ChatCore = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const PROTOCOL = 'zhitiao/1';
  const MAX_LENGTH = 2000;
  const MAX_MESSAGES = 300;
  const BURN_SECONDS = 10;

  let seq = 0;
  function newId() {
    seq += 1;
    return 'm' + Date.now().toString(36) + seq.toString(36);
  }

  function createChat(options) {
    const opts = options || {};
    const now = opts.now || (() => Date.now());
    const maxLength = opts.maxLength || MAX_LENGTH;

    const state = {
      messages: [],
      /** 我发出的、还没收到回执的消息 id */
      waitingAck: new Set(),
      /** 收到但还没告诉对方"我看了"的消息 id */
      unreadPeer: new Set(),
      peerName: '',
      connected: false,
    };

    function trim() {
      if (state.messages.length > MAX_MESSAGES) {
        state.messages.splice(0, state.messages.length - MAX_MESSAGES);
      }
    }

    function find(id) {
      return state.messages.find((m) => m.id === id) || null;
    }

    const chat = {
      PROTOCOL,
      state,

      reset() {
        state.messages = [];
        state.waitingAck.clear();
        state.unreadPeer.clear();
        state.peerName = '';
      },

      setPeerName(name) {
        state.peerName = String(name || '').slice(0, 16);
      },

      /** 发出：先落本地，状态 sending；拿到 ack 才算 delivered */
      addOutgoing(text, burn) {
        const clean = String(text == null ? '' : text).replace(/\s+$/, '');
        if (!clean) return { ok: false, error: '内容为空' };
        if (clean.length > maxLength) return { ok: false, error: '太长了' };

        const msg = {
          id: newId(),
          side: 'me',
          text: clean,
          ts: now(),
          burn: !!burn,
          status: 'sending',
        };
        state.messages.push(msg);
        state.waitingAck.add(msg.id);
        trim();
        return { ok: true, message: msg };
      },

      /** 对方的 ack：sending -> delivered */
      onAck(id) {
        const m = find(id);
        if (!m || m.side !== 'me') return false;
        state.waitingAck.delete(id);
        if (m.status === 'sending' || m.status === 'failed') {
          m.status = 'delivered';
          return true;
        }
        return false;
      },

      /** 我方失败（连接断了） */
      markFailed(id) {
        const m = find(id);
        if (!m || m.side !== 'me') return false;
        state.waitingAck.delete(id);
        m.status = 'failed';
        return true;
      },

      /** 断线时把所有还在路上的标记为失败 */
      failPending() {
        let n = 0;
        for (const id of [...state.waitingAck]) {
          if (chat.markFailed(id)) n += 1;
        }
        return n;
      },

      /** 收到对方消息：立刻回 ack，并记进"待已读" */
      receive(msg) {
        const text = String((msg && msg.text) || '').slice(0, maxLength);
        if (!text) return null;
        const m = {
          id: String((msg && msg.id) || newId()),
          side: 'peer',
          text,
          ts: Number((msg && msg.ts) || 0) || now(),
          burn: !!(msg && msg.burn),
          status: 'delivered',
        };
        state.messages.push(m);
        state.unreadPeer.add(m.id);
        trim();
        return m;
      },

      /** 对方的已读回执：我的消息 delivered -> read */
      onSeen(ids) {
        const set = new Set(ids || []);
        let changed = 0;
        for (const m of state.messages) {
          if (m.side === 'me' && set.has(m.id) && m.status !== 'read') {
            m.status = 'read';
            changed += 1;
          }
        }
        return changed;
      },

      /** 我这边的"已读"：把收到的、还没上报的 id 交出去 */
      takeSeenIds() {
        const ids = [...state.unreadPeer];
        state.unreadPeer.clear();
        return ids;
      },

      /** 焚毁：两端都删掉 */
      burn(id) {
        const i = state.messages.findIndex((m) => m.id === id);
        if (i < 0) return false;
        state.messages.splice(i, 1);
        state.waitingAck.delete(id);
        state.unreadPeer.delete(id);
        return true;
      },

      addSystem(text) {
        state.messages.push({
          id: newId(),
          side: 'system',
          text: String(text || ''),
          ts: now(),
          burn: false,
          status: 'read',
        });
        trim();
      },

      messages() {
        return state.messages;
      },

      pendingCount() {
        return state.waitingAck.size;
      },
    };

    return chat;
  }

  /** 消息协议：进出都是这种小对象 */
  function pack(type, data) {
    return Object.assign({ t: type, p: PROTOCOL }, data || {});
  }

  function parse(raw) {
    if (!raw || typeof raw !== 'object') return null;
    if (typeof raw.t !== 'string') return null;
    return raw;
  }

  return {
    PROTOCOL,
    MAX_LENGTH,
    BURN_SECONDS,
    createChat,
    pack,
    parse,
  };
});
