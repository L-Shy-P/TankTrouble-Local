'use strict';
/* 探针：真实时间渗入 & 随机数消费者归因（只读 + 新建探针，不动 game_core）
 *
 * 做法：拦截 cdp.launch 返回的 browser.send，在 match.js 注入的
 *   「CLOCK_SRC + helpers + record_page + rng prelude」源码外面再包一层：
 *     前插：保存真实 Date.now / performance.now（因为 clock.js 之后会接管）
 *     后插：包 window.setTimeout / setInterval / Math.random，
 *           记录每次 timer 调度/触发时的虚拟 steps、真实时刻、该回调消耗了多少次 Math.random
 * 所以这不是改游戏代码，而是在「注入源码」上再叠一层探针。
 *
 *   node _tools/headless/_probe_timers.js --frames 600 [--slow 0] [--out prof/timers.json]
 */
const fs = require('fs');
const path = require('path');

const cdp = require('./cdp');
const realLaunch = cdp.launch;
let launchSeq = 0;
const LAUNCH_BASE = 17200 + (process.pid % 50) * 40;

const PRE = `(() => {
  try {
    var R = window.Date, P = window.performance;
    window.__probeRealNow = function () { try { return R.now ? R.now() : new R().getTime(); } catch (e) { return -1; } };
    window.__probeRealPerf = function () { try { return (P && P.now) ? P.now() : -1; } catch (e) { return -1; } };
  } catch (e) {}
})();`;

const POST = `(() => {
  if (window.__probeTimers) return;
  var P = { sched: [], fires: [], seq: 0, rngCount: 0, rngInTimer: 0, errs: 0 };
  window.__probeTimers = P;
  var realRnd = Math.random;
  Math.random = function () {
    P.rngCount++;
    var v = realRnd.apply(this, arguments);
    if (P.currentFire) P.currentFire.rngVals.push(v);
    return v;
  };
  var rt = window.setTimeout, ri = window.setInterval;
  function wrap(kind, cb, delay) {
    if (typeof cb !== 'function') return cb;
    var s = { i: P.sched.length, kind: kind, delay: delay,
              schedSteps: (window.__vt ? window.__vt.steps : -1),
              schedT: (window.__vt ? window.__vt.t : -1),
              schedReal: window.__probeRealNow(), rngAtSched: P.rngCount, fires: 0, rngUsed: 0 };
    P.sched.push(s);
    return function () {
      s.fires++;
      var f = { i: s.i, kind: kind, delay: delay, schedSteps: s.schedSteps,
                fireSteps: (window.__vt ? window.__vt.steps : -1),
                fireT: (window.__vt ? window.__vt.t : -1),
                fireReal: window.__probeRealNow(), rngBefore: P.rngCount,
                rngVals: [], stack: null };
      P.fires.push(f);
      var out;
      try {
        f.stack = (new Error()).stack ? String((new Error()).stack).split(String.fromCharCode(10)).slice(1, 6).join(' | ') : null;
        P.currentFire = f;
        out = cb.apply(this, arguments);
      }
      finally {
        P.currentFire = null;
        f.rngUsed = P.rngCount - f.rngBefore;
        s.rngUsed += f.rngUsed;
        if (f.rngUsed) { P.rngInTimer += f.rngUsed; s.rngVals = (s.rngVals || []).concat(f.rngVals); }
      }
      return out;
    };
  }
  window.setTimeout = function (cb, delay) {
    var a = Array.prototype.slice.call(arguments); a[0] = wrap('timeout', cb, delay); return rt.apply(window, a);
  };
  window.setInterval = function (cb, delay) {
    var a = Array.prototype.slice.call(arguments); a[0] = wrap('interval', cb, delay); return ri.apply(window, a);
  };
  window.__probeTimerSummary = function () {
    var byDelay = {}, rngFires = [];
    for (var i = 0; i < P.sched.length; i++) {
      var s = P.sched[i];
      var k = s.kind + ':' + s.delay;
      byDelay[k] = byDelay[k] || { n: 0, fires: 0, rngUsed: 0, rngVals: [] };
      byDelay[k].n++; byDelay[k].fires += s.fires; byDelay[k].rngUsed += s.rngUsed;
      if (s.rngVals) byDelay[k].rngVals = byDelay[k].rngVals.concat(s.rngVals);
    }
    for (var j = 0; j < P.fires.length; j++) {
      if (P.fires[j].rngUsed) rngFires.push(P.fires[j]);
    }
    var g = null;
    try {
      var game = GameManager.getGame();
      if (game && game.rnd) g = { s0: game.rnd.s0, s1: game.rnd.s1, s2: game.rnd.s2, c: game.rnd.c };
    } catch (e) {}
    return { totalSched: P.sched.length, totalFires: P.fires.length, rngCount: P.rngCount,
             rngInTimer: P.rngInTimer, byDelay: byDelay,
             rngFireCount: rngFires.length, rngFiresSample: rngFires.slice(0, 40),
             firesSample: P.fires.slice(0, 40), phaserRnd: g,
             vtSteps: (window.__vt ? window.__vt.steps : null), vtT: (window.__vt ? window.__vt.t : null),
             rngState: window.__vtRng.state(), recStats: window.__vtRec ? window.__vtRec.stats() : null,
             recInit: window.__vtRec && window.__vtRec.header ? (function(){ try { return JSON.parse(window.__vtRec.header()).init; } catch(e){ return null; } })() : null };
  };
})();`;

cdp.launch = function (opts) {
  const o = Object.assign({}, opts || {});
  if (!o.port) o.port = LAUNCH_BASE + (launchSeq++) % 40;
  return realLaunch(o).then((b) => {
    const origSend = b.send.bind(b);
    b.send = function (method, params, sessionId) {
      if (method === 'Page.addScriptToEvaluateOnNewDocument' && params && params.source) {
        params = Object.assign({}, params, { source: PRE + ';' + params.source + ';' + POST });
      }
      return origSend(method, params, sessionId);
    };
    return b;
  });
};

const { Match } = require('./match');
const { recordEpisode, readRecording } = require('./record');

const argv = process.argv.slice(2);
const num = (name, d) => { const i = argv.indexOf('--' + name); return i < 0 ? d : Number(argv[i + 1]); };
const str = (name, d) => { const i = argv.indexOf('--' + name); return i < 0 ? d : argv[i + 1]; };
const FRAMES = num('frames', 600);
const SLOW = num('slow', 0);
const OUT = str('out', path.join(__dirname, 'prof', 'timers_probe.json'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const origOpen = Match.prototype.open;
Match.prototype.open = async function (opts) {
  this.__probePhase = 'open';
  try { return await origOpen.call(this, opts || {}); }
  finally { this.__probePhase = 'play'; }
};
const origPump = Match.prototype.pump;
Match.prototype.pump = async function (n, opts) {
  if (!SLOW) return origPump.call(this, n, opts);
  let done = 0;
  while (done < n) { await origPump.call(this, 1, { yieldMs: 0 }); done++; await sleep(SLOW); }
  return done;
};

(async () => {
  const m = new Match();
  const outRec = path.join(__dirname, 'prof', `_probe_timers_rec_${FRAMES}.jsonl`);
  try {
    const t0 = Date.now();
    const info = await recordEpisode(m, { frames: FRAMES, out: outRec });
    const summary = await m.eval('window.__probeTimerSummary()');
    const vtStats = await m.eval('window.__vtStats()');
    const pageRec = readRecording(outRec);
    const payload = { frames: FRAMES, slowMs: SLOW, wallMs: Date.now() - t0, rec: {
      frames: info.frames, fnv: info.fnv, pageFnv: info.pageFnv, rngLen: info.rng.len, overflow: info.rng.overflow,
      drive: info.drive,
    }, vtStats, timerSummary: summary, pageMeta: pageRec.meta, headerInit: pageRec.header.init };
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify(payload, null, 2));
    console.log(JSON.stringify({
      ok: true, out: OUT, frames: FRAMES, slowMs: SLOW, wallMs: payload.wallMs,
      rngLen: info.rng.len, totalSched: summary.totalSched, totalFires: summary.totalFires,
      rngCount: summary.rngCount, rngInTimer: summary.rngInTimer, rngFireCount: summary.rngFireCount,
      phaserRnd: summary.phaserRnd, vtSteps: summary.vtSteps, byDelay: summary.byDelay,
    }, null, 2));
  } catch (e) {
    console.error('FAILED:', (e && e.stack) || e);
    process.exitCode = 1;
  } finally { await m.close(); }
})();
