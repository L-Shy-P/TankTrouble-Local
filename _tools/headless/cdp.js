'use strict';
/* 极简 CDP 驱动 —— 用 Node 24 自带的 WebSocket，零 npm 依赖。
 *
 * 只做我们需要的：启动浏览器 → 开标签页 → 注入脚本 → 导航 → evaluate。
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
];

function findBrowser() {
  for (const p of CANDIDATES) { try { if (fs.existsSync(p)) return p; } catch (e) {} }
  throw new Error('找不到 Chrome / Edge');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitHttp(url, timeoutMs = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(url);
      if (r.ok) return await r.json();
    } catch (e) {}
    await sleep(120);
  }
  throw new Error('等待 CDP 超时: ' + url);
}

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    this.listeners = new Map();
    // 最近发生的事件（用于 waitFor 回溯）
    this.recent = [];
    ws.addEventListener('message', (ev) => this._onMessage(ev));
  }

  _onMessage(ev) {
    let msg;
    try { msg = JSON.parse(ev.data); } catch (e) { return; }
    if (msg.id != null) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message + ' (' + JSON.stringify(msg.error.data || '') + ')'));
      else p.resolve(msg.result);
      return;
    }
    // 事件
    const key = msg.method + '@' + (msg.sessionId || '');
    this.recent.push({ method: msg.method, sessionId: msg.sessionId, params: msg.params, t: Date.now() });
    if (this.recent.length > 500) this.recent.splice(0, 250);
    const ls = this.listeners.get(key) || [];
    for (const l of ls.slice()) l(msg.params, msg.sessionId);
    const lsAny = this.listeners.get('*') || [];
    for (const l of lsAny.slice()) l(msg.method, msg.params, msg.sessionId);
  }

  send(method, params = {}, sessionId) {
    const id = ++this.seq;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try { this.ws.send(JSON.stringify(payload)); }
      catch (e) { this.pending.delete(id); reject(e); }
    });
  }

  on(method, cb, sessionId) {
    const key = method + '@' + (sessionId || '');
    if (!this.listeners.has(key)) this.listeners.set(key, []);
    this.listeners.get(key).push(cb);
    return () => {
      const arr = this.listeners.get(key) || [];
      const i = arr.indexOf(cb);
      if (i >= 0) arr.splice(i, 1);
    };
  }

  /** 等一个事件；会先查最近的 200 条，避免竞态 */
  waitFor(method, timeoutMs = 15000, sessionId) {
    const key = method + '@' + (sessionId || '');
    const hit = this.recent.find((r) => r.method + '@' + (r.sessionId || '') === key);
    if (hit) {
      this.recent.splice(this.recent.indexOf(hit), 1);
      return Promise.resolve(hit.params);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { off(); reject(new Error('等待事件超时: ' + method)); }, timeoutMs);
      const off = this.on(method, (params) => { clearTimeout(timer); off(); resolve(params); }, sessionId);
    });
  }

  async newPage(url = 'about:blank') {
    const { targetId } = await this.send('Target.createTarget', { url });
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true });
    return { targetId, sessionId };
  }

  async closePage(targetId) { try { await this.send('Target.closeTarget', { targetId }); } catch (e) {} }

  /** 在页面里求值；opts: {awaitPromise, returnByValue, timeoutMs} */
  async evaluate(expression, sessionId, opts = {}) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: opts.awaitPromise !== false,
      returnByValue: opts.returnByValue !== false,
      userGesture: true,
    }, sessionId);
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      const msg = (d.exception && (d.exception.description || d.exception.value)) || d.text;
      const err = new Error('页面异常: ' + msg);
      err.pageError = d;
      throw err;
    }
    return r.result && r.result.value;
  }

  async close() {
    try { this.ws.close(); } catch (e) {}
    try { if (this.proc && !this.proc.killed) this.proc.kill('SIGKILL'); } catch (e) {}
    await sleep(200);
    try { if (this.userDataDir) fs.rmSync(this.userDataDir, { recursive: true, force: true, maxRetries: 3 }); } catch (e) {}
  }
}

/** 启动无头浏览器并返回 CDP 句柄（已连到 browser 级 WS） */
async function launch(opts = {}) {
  const exe = opts.exe || findBrowser();
  // ★ 2026-10-11：原来在 9300~9699 随机挑端口，多 agent 并发时会连到【别人的浏览器】
  //   （基线稳定性调查 §三.8；本次 verify 也实测撞上激光代理的 9515）。改成按 PID 独占。
  const port = opts.port || (18400 + (process.pid % 1000));
  const userDataDir = opts.userDataDir || fs.mkdtempSync(path.join(os.tmpdir(), 'vt-chrome-'));
  const args = [
    '--headless=new',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--mute-audio',
    '--hide-scrollbars',
    '--allow-file-access-from-files',
    '--autoplay-policy=no-user-gesture-required',
    '--enable-unsafe-swiftshader',
    '--window-size=1280,1024',
    '--remote-debugging-port=' + port,
    '--user-data-dir=' + userDataDir,
    'about:blank',
  ];
  if (opts.extraArgs) args.unshift(...opts.extraArgs);

  // ★ 不用管道：某些沙箱环境下 spawn 用 stdio:'pipe' 会 EPERM
  const proc = spawn(exe, args, { stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true });
  proc.on('error', () => {});
  const info = await waitHttp(`http://127.0.0.1:${port}/json/version`, opts.timeoutMs || 25000);
  const ws = new WebSocket(info.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('WS 连接失败')), { once: true });
  });
  const cdp = new CDP(ws);
  cdp.proc = proc;
  cdp.userDataDir = userDataDir;
  cdp.port = port;
  cdp.browserInfo = info;
  await cdp.send('Target.setDiscoverTargets', { discover: true });
  return cdp;
}

module.exports = { CDP, launch, findBrowser, sleep, waitHttp };
