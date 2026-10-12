'use strict';
/* 无头会话运行器 —— 核心工具
 *
 *   node _tools/headless/run.js --script scripts/xxx.js [--frames N] [--settle N]
 *
 * 流程：起服务器 → 起无头 Chrome → 注入虚拟时钟 → 打开游戏 → 等 load
 *      → 泵 N 帧 → 等 settle 毫秒（真实时间，给 socket/资源用）
 *      → 求值 script（表达式，返回什么就打什么）→ 收尾
 *
 * script 文件内容会作为【页面内表达式】执行（支持 async IIFE）。
 */
const path = require('path');
const fs = require('fs');
const { launch, sleep } = require('./cdp');
const { startServer } = require('./serve');
const { startPyServer } = require('./pyserver');

const ROOT = path.resolve(__dirname, '..', '..');
const GAME_DIR = path.join(ROOT, 'game_core');
const CLOCK_SRC = fs.readFileSync(path.join(__dirname, 'clock.js'), 'utf8');

function arg(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return dflt;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}
function argAll(name) {
  const out = [];
  for (let i = 0; i < process.argv.length; i++) {
    if (process.argv[i] === '--' + name) {
      const v = process.argv[i + 1];
      if (v && !v.startsWith('--')) out.push(v);
    }
  }
  return out;
}

const DEFAULT_SCRIPT = `(() => {
  const keys = [];
  for (const k in window) if (/^(Game|Client|AI|Users|Constants|Backend|Inputs)/.test(k)) keys.push(k + ':' + typeof window[k]);
  return { readyState: document.readyState, globals: keys };
})()`;

(async () => {
  const frames = Number(arg('frames', 240));
  const settle = Number(arg('settle', 1500));
  const page = String(arg('url', 'index.html'));
  const scripts = argAll('script');
  const quiet = !!arg('quiet', false);

  // 默认用 game_core/server.py（带 /ajax/ 游客登录 + AI 列表）；--server static 才用简易静态服务器
  const useStatic = String(arg('server', 'py')) === 'static';
  const srv = useStatic ? await startServer(GAME_DIR, 0) : await startPyServer({});
  const browser = await launch({});
  const consoleLines = [];
  const pageErrors = [];
  let sessionId, targetId;

  try {
    const np = await browser.newPage('about:blank');
    sessionId = np.sessionId; targetId = np.targetId;

    browser.on('Runtime.consoleAPICalled', (p) => {
      const txt = (p.args || []).map((a) => (a.value !== undefined ? a.value : (a.description || a.type))).join(' ');
      consoleLines.push(`[${p.type}] ${txt}`.slice(0, 500));
      if (consoleLines.length > 300) consoleLines.splice(0, 150);
    }, sessionId);
    browser.on('Runtime.exceptionThrown', (p) => {
      const d = p.exceptionDetails || {};
      pageErrors.push(String((d.exception && d.exception.description) || d.text).slice(0, 700));
    }, sessionId);

    await browser.send('Page.enable', {}, sessionId);
    await browser.send('Runtime.enable', {}, sessionId);
    await browser.send('Page.addScriptToEvaluateOnNewDocument', { source: CLOCK_SRC }, sessionId);

    const t0 = Date.now();
    const loaded = browser.waitFor('Page.loadEventFired', 60000, sessionId);
    await browser.send('Page.navigate', { url: `${srv.origin}/${page}` }, sessionId);
    await loaded;
    const loadMs = Date.now() - t0;

    if (settle > 0) await sleep(settle);

    const out = { ok: true, loadMs, results: [] };

    // ---- 泵帧 ----
    // 关键教训：虚拟时钟会把真实 I/O（图片/XHR）也一起冻住。
    // 一口气 __vtStep(120) 只要 10ms，图片根本没时间下完，于是永远卡在 Boot。
    // 所以资产加载阶段必须「推进几帧 → 让出真实时间」交错进行；
    // 资源到位后可以全速空转（纯物理不依赖真实时间）。
    const yieldMs = Number(arg('yield', 0));
    const chunkSize = Number(arg('chunk', 0)) || (yieldMs > 0 ? 1 : (frames || 1));
    const until = arg('until', null);
    const STATE_PROBE = "(()=>{try{return GameManager.getGame().state.current}catch(e){return '?'}})()";

    let pumped = 0;
    const stateLog = [];
    const t1 = Date.now();
    let last = null;
    while (pumped < frames) {
      const n = Math.min(chunkSize, frames - pumped);
      await browser.evaluate(`window.__vtStep(${n})`, sessionId);
      pumped += n;
      if (yieldMs > 0) await sleep(yieldMs);
      if (until) {
        const cur = await browser.evaluate(STATE_PROBE, sessionId);
        if (cur !== last) { stateLog.push(`${pumped}帧 → ${cur}`); last = cur; }
        if (cur === until) break;
      }
    }
    out.stepMs = Date.now() - t1;
    out.fps = +(pumped / (out.stepMs / 1000)).toFixed(1);
    out.pumped = pumped;
    if (stateLog.length) out.stateLog = stateLog;
    out.stats = await browser.evaluate('window.__vtStats()', sessionId);

    const list = scripts.length ? scripts : ['(default)'];
    for (const s of list) {
      const src = s === '(default)' ? DEFAULT_SCRIPT : fs.readFileSync(path.resolve(__dirname, s), 'utf8');
      try {
        out.results.push({ script: s, value: await browser.evaluate(src, sessionId, { awaitPromise: true }) });
      } catch (e) {
        out.results.push({ script: s, error: String(e.message).slice(0, 1500) });
      }
    }

    out.statsAfter = await browser.evaluate('window.__vtStats()', sessionId).catch(() => null);
    out.pageErrors = pageErrors.slice(0, 6);
    if (!quiet) out.console = consoleLines.slice(-20);

    console.log(JSON.stringify(out, null, 2));
  } finally {
    if (targetId) await browser.closePage(targetId);
    await browser.close();
    await srv.close();
  }
})().catch((e) => { console.error('RUN FAILED:', (e && e.stack) || e); process.exit(1); });
