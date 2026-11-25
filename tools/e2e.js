// 网页版端到端测试：真起一个 Edge，开两个标签页，一个摆桌一个入座，互发消息。
// 用法：node tools/e2e.js
//
// 每次运行都用临时的静态端口、临时的调试端口、临时的浏览器 profile，
// 结束用 taskkill /T 杀掉整棵进程树——否则上一轮的 Edge 会抢端口，导致假失败。
'use strict';

const { spawn, spawnSync } = require('child_process');
const http = require('http');
const net = require('net');
const os = require('os');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const SHOTS = path.join(__dirname, 'shots');

let pass = 0;
let fail = 0;
function ok(cond, label, extra) {
  if (cond) {
    pass++;
    console.log('PASS  ' + label);
  } else {
    fail++;
    console.log('FAIL  ' + label + (extra === undefined ? '' : '  -> ' + String(extra).slice(0, 300)));
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------------------------------------------------------- 端口 */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

/* ---------------------------------------------------------------- 静态服务器 */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
};

function startStatic() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const urlPath = decodeURIComponent(req.url.split('?')[0]);
      const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
      const file = path.join(ROOT, rel);
      if (!file.startsWith(ROOT) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
        res.writeHead(404);
        return res.end('404');
      }
      const body = fs.readFileSync(file);
      res.writeHead(200, { 'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
      res.end(body);
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
  });
}

/* ---------------------------------------------------------------- CDP */
class CDP {
  constructor(url) {
    this.url = url;
    this.id = 0;
    this.pending = new Map();
    this.ws = null;
  }
  async open() {
    this.ws = new WebSocket(this.url);
    await new Promise((res, rej) => {
      this.ws.addEventListener('open', res, { once: true });
      this.ws.addEventListener('error', () => rej(new Error('CDP 连接失败')), { once: true });
    });
    this.ws.addEventListener('message', (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.id && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
        else p.resolve(msg.result);
      }
    });
  }
  send(method, params, sessionId) {
    const id = ++this.id;
    const payload = { id, method, params: params || {} };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(payload));
    });
  }
}

function getJSON(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let b = '';
      res.on('data', (d) => (b += d));
      res.on('end', () => {
        try {
          resolve(JSON.parse(b));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(3000, () => req.destroy(new Error('timeout')));
  });
}

async function waitFor(fn, timeout = 25000, interval = 400) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (await fn()) return true;
    await sleep(interval);
  }
  return false;
}

function killTree(pid) {
  try {
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
  } catch {}
}

function rmDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {}
}

/* ---------------------------------------------------------------- 主流程 */
(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const { srv, port } = await startStatic();
  const BASE = 'http://127.0.0.1:' + port + '/';
  const debugPort = await freePort();
  const userDir = path.join(os.tmpdir(), 'zhitiao-e2e-' + Date.now());
  console.log('静态服务: ' + BASE + '  调试端口: ' + debugPort);

  const edge = spawn(EDGE, [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--disable-crash-reporter',
    '--remote-debugging-port=' + debugPort,
    '--user-data-dir=' + userDir,
    '--window-size=1100,780',
    'about:blank',
  ], { stdio: 'ignore' });

  let cdp;
  try {
    const ready = await waitFor(async () => {
      try {
        const v = await getJSON('http://127.0.0.1:' + debugPort + '/json/version');
        return !!v.webSocketDebuggerUrl;
      } catch {
        return false;
      }
    }, 25000, 500);
    if (!ready) throw new Error('Edge 调试端口没起来');

    const ver = await getJSON('http://127.0.0.1:' + debugPort + '/json/version');
    cdp = new CDP(ver.webSocketDebuggerUrl);
    await cdp.open();

    async function openTab(url) {
      const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
      const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
      await cdp.send('Page.enable', {}, sessionId);
      await cdp.send('Runtime.enable', {}, sessionId);
      await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
        source:
          'window.__errs=[];' +
          'window.addEventListener("error",e=>window.__errs.push(String(e.message)));' +
          'window.addEventListener("unhandledrejection",e=>window.__errs.push("rej:"+String(e.reason)));',
      }, sessionId);
      await cdp.send('Page.navigate', { url }, sessionId);
      return sessionId;
    }

    const evalJS = async (sid, expr) => {
      const r = await cdp.send('Runtime.evaluate', {
        expression: `(async () => { ${expr} })()`,
        awaitPromise: true,
        returnByValue: true,
      }, sid);
      if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400));
      return r.result.value;
    };

    const shot = async (sid, name) => {
      const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' }, sid);
      fs.writeFileSync(path.join(SHOTS, name), Buffer.from(data, 'base64'));
    };

    /* ---- 开两个标签页 ---- */
    const A = await openTab(BASE);
    const B = await openTab(BASE);
    await sleep(2500);

    ok((await evalJS(A, 'return window.__errs || []')).length === 0, 'A 页无 JS 报错');
    ok((await evalJS(B, 'return window.__errs || []')).length === 0, 'B 页无 JS 报错');
    ok(await evalJS(A, 'return typeof window.Peer === "function"'), 'peerjs 已加载');
    ok(await evalJS(A, 'return typeof ChatCore === "object"'), 'chat-core 已加载');

    await shot(A, '1-home.png');

    /* ---- A 摆桌 ---- */
    await evalJS(A, 'document.getElementById("host-name").value = "阿哲"; return true;');
    await evalJS(A, 'document.getElementById("btn-host").click(); return true;');
    const gotCode = await waitFor(async () => {
      const c = await evalJS(A, 'return document.getElementById("wait-code").textContent');
      return /^\d{4}$/.test(c);
    }, 20000);
    const code = await evalJS(A, 'return document.getElementById("wait-code").textContent');
    ok(gotCode, 'A 摆桌并拿到房间号: ' + code);

    const hostReady = await waitFor(async () => {
      const s = await evalJS(A, 'return document.getElementById("wait-status").textContent');
      return String(s).includes('等待');
    }, 20000);
    ok(hostReady, 'A 已连上信令服务器，处于等待状态');
    await shot(A, '2-waiting.png');

    /* ---- B 加入 ---- */
    await evalJS(B, `
      document.getElementById("join-code").value = ${JSON.stringify(code)};
      document.getElementById("join-name").value = "小林";
      document.getElementById("form-join").requestSubmit();
      return true;
    `);

    ok(await waitFor(async () => await evalJS(B, 'return !document.getElementById("screen-chat").hidden'), 30000),
      'B 入座成功，进入对话界面');
    ok(await waitFor(async () => await evalJS(A, 'return !document.getElementById("screen-chat").hidden'), 20000),
      'A 端也切到对话界面');

    const peerNameOnA = await evalJS(A, 'return (document.querySelector("#statusbar b")||{}).textContent');
    ok(peerNameOnA === '小林', 'A 看到对方称呼「小林」', peerNameOnA);

    const peerNameOnB = await evalJS(B, 'return (document.querySelector("#statusbar b")||{}).textContent');
    ok(peerNameOnB === '阿哲', 'B 看到主人称呼「阿哲」', peerNameOnB);

    /* ---- A 发一条 ---- */
    await evalJS(A, `
      document.getElementById("input").value = "你好，我是摆桌的那个";
      document.getElementById("form-send").requestSubmit();
      return true;
    `);
    await sleep(1500);

    const bText = await evalJS(B, 'return [...document.querySelectorAll(".msg.peer .note > div:first-child")].map(e=>e.textContent).join("|")');
    ok(String(bText).includes('你好，我是摆桌的那个'), 'B 收到消息', bText);

    const aStatus = await evalJS(A, 'return (document.querySelector(".msg.me .state")||{}).textContent');
    ok(aStatus === '已送达' || aStatus === '已读', 'A 侧显示送达状态', aStatus);

    const readReached = await waitFor(async () => {
      const s = await evalJS(A, 'return (document.querySelector(".msg.me .state")||{}).textContent');
      return s === '已读';
    }, 8000);
    ok(readReached, 'B 看了之后 A 侧变「已读」');

    /* ---- B 回一条 ---- */
    await evalJS(B, `
      document.getElementById("input").value = "收到，我在马路对面";
      document.getElementById("form-send").requestSubmit();
      return true;
    `);
    await sleep(1200);
    const aText = await evalJS(A, 'return [...document.querySelectorAll(".msg.peer .note > div:first-child")].map(e=>e.textContent).join("|")');
    ok(String(aText).includes('收到，我在马路对面'), 'A 收到回复', aText);

    /* ---- 阅后即焚 ---- */
    await evalJS(A, `
      document.getElementById("burn").checked = true;
      document.getElementById("input").value = "这句看完就没了";
      document.getElementById("form-send").requestSubmit();
      return true;
    `);
    await sleep(1200);
    ok(await evalJS(B, 'return !!document.querySelector(".note.burn-note")'), 'B 侧显示「阅后即焚」标记');

    ok(await waitFor(async () => await evalJS(B, 'return !document.body.innerText.includes("这句看完就没了")'), 18000),
      '10 秒后纸条在 B 侧自动消失');
    await sleep(800);
    ok(await evalJS(A, 'return !document.body.innerText.includes("这句看完就没了")'), 'A 侧也同步消失');

    await shot(A, '3-chat-host.png');
    await shot(B, '4-chat-guest.png');

    /* ---- 页面加载后有没有留下报错 ---- */
    ok((await evalJS(A, 'return window.__errs || []')).length === 0, '全程 A 无 JS 报错');
    ok((await evalJS(B, 'return window.__errs || []')).length === 0, '全程 B 无 JS 报错');
  } catch (e) {
    fail++;
    console.log('FAIL  异常中断: ' + e.message);
  } finally {
    killTree(edge.pid);
    try {
      srv.close();
    } catch {}
    await sleep(300);
    rmDir(userDir);
    console.log('');
    console.log(`结果：${pass} 通过 / ${fail} 失败`);
    process.exit(fail ? 1 : 0);
  }
})();
