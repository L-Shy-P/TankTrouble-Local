'use strict';
/* 探针：Math.random 调用点归因 —— 找出「录制 vs 回放」里随机数消费【顺序/时机】的差异
 *
 * 做法（不改 game_core、不改 clock.js 逻辑，只在注入源码后面再叠一层包装）：
 *   · 在页面里包装 Math.random，记录每次调用的 { vt.steps, 消费计数, 调用栈 }
 *   · 先 record 一局 → dump；再用同一份录制 replay → dump
 *   · 逐次比调用栈：第一处不同就是根因所在（谁在 record 里吃了、replay 里没吃/晚吃）
 *
 *   node _tools/headless/_probe_rng_attrib.js --frames 1200 --max-steps 60
 */
const fs = require('fs');
const path = require('path');

const cdp = require('./cdp');
const realLaunch = cdp.launch;
let launchSeq = 0;
const LAUNCH_BASE = 17300 + (process.pid % 50) * 40;

const POST = `(() => {
  if (window.__rngAttrib) return;
  var P = { on: true, calls: [], cap: 40000, maxSteps: 480 };
  window.__rngAttrib = P;
  var real = Math.random;
  Math.random = function () {
    var v = real.apply(this, arguments);
    try {
      if (P.on && window.__vt && window.__vt.steps <= P.maxSteps && P.calls.length < P.cap) {
        var s = null;
        try { s = window.__vtRng.state(); } catch (e) {}
        var st = null;
        try { st = String(new Error().stack).split(String.fromCharCode(10)).slice(1, 6).join(' | '); } catch (e) {}
        P.calls.push({ k: P.calls.length, st: window.__vt.steps, rn: s ? (s.mode === 'play' ? s.idx : s.len) : -1, stack: st });
      }
    } catch (e) {}
    return v;
  };
  window.__rngAttribSetMax = function (maxSteps) { P.maxSteps = maxSteps | 0 || 400; return P.maxSteps; };
})();`;

cdp.launch = function (opts) {
  const o = Object.assign({}, opts || {});
  if (!o.port) o.port = LAUNCH_BASE + (launchSeq++) % 40;
  return realLaunch(o).then((b) => {
    const origSend = b.send.bind(b);
    b.send = function (method, params, sessionId) {
      if (method === 'Page.addScriptToEvaluateOnNewDocument' && params && params.source) {
        params = Object.assign({}, params, { source: params.source + ';' + POST });
      }
      return origSend(method, params, sessionId);
    };
    return b;
  });
};

const { Match } = require('./match');
const { recordEpisode, readRecording, replayEpisode } = require('./record');

// replayEpisode 内部自己 new Match 并 close；patch close 把页面里的调用日志带出来
let lastAttrib = null;
const origClose = Match.prototype.close;
Match.prototype.close = async function () {
  try { lastAttrib = await this.eval('window.__rngAttrib ? window.__rngAttrib.calls : null'); } catch (e) {}
  return origClose.call(this);
};

const argv = process.argv.slice(2);
const num = (name, d) => { const i = argv.indexOf('--' + name); return i < 0 ? d : Number(argv[i + 1]); };
const FRAMES = num('frames', 1200);
const MAX_STEPS = num('max-steps', 480);
const OUT = path.join(__dirname, 'prof', 'detfix', `attrib_rec_${FRAMES}.jsonl`);
const REP = path.join(__dirname, 'prof', 'detfix', `attrib_rep_${FRAMES}.jsonl`);

function topFrames(calls) {
  const m = {};
  for (const c of calls) {
    const k = (c.stack || '').split(' | ')[2] || (c.stack || '').split(' | ')[1] || '(none)';
    m[k] = (m[k] || 0) + 1;
  }
  return Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, 25);
}

(async () => {
  // ---- 1) 录制 ----
  const m = new Match();
  await recordEpisode(m, { frames: FRAMES, out: OUT, open: { } });
  const logRec = await m.eval('window.__rngAttrib ? window.__rngAttrib.calls : null');
  await m.close();
  // ---- 2) 回放 ----
  const rec = readRecording(OUT);
  lastAttrib = null;
  await replayEpisode(rec, { out: REP });
  const logRep = lastAttrib;

  const out = { frames: FRAMES, maxSteps: MAX_STEPS, recFile: OUT, repFile: REP,
                recCalls: logRec ? logRec.length : 0, repCalls: logRep ? logRep.length : 0 };
  if (logRec && logRep) {
    const n = Math.min(logRec.length, logRep.length);
    let first = -1;
    for (let i = 0; i < n; i++) {
      if (logRec[i].stack !== logRep[i].stack || logRec[i].st !== logRep[i].st || logRec[i].rn !== logRep[i].rn) { first = i; break; }
    }
    out.firstDivergence = first;
    out.recTop = topFrames(logRec);
    out.repTop = topFrames(logRep);
    if (first >= 0) {
      out.at = {
        rec: { i: logRec[first].k, st: logRec[first].st, rn: logRec[first].rn, stack: logRec[first].stack },
        rep: { i: logRep[first].k, st: logRep[first].st, rn: logRep[first].rn, stack: logRep[first].stack },
      };
      out.contextRec = logRec.slice(Math.max(0, first - 4), first + 8).map((c) => `[${c.k}] st=${c.st} rn=${c.rn} ${(c.stack || '').split(' | ').slice(1, 4).join(' <- ')}`);
      out.contextRep = logRep.slice(Math.max(0, first - 4), first + 8).map((c) => `[${c.k}] st=${c.st} rn=${c.rn} ${(c.stack || '').split(' | ').slice(1, 4).join(' <- ')}`);
    }
  }
  const rawFile = path.join(__dirname, 'prof', 'detfix', `attrib_raw_${FRAMES}.json`);
  try { fs.writeFileSync(rawFile, JSON.stringify({ rec: logRec, rep: logRep })); } catch (e) {}
  const outFile = path.join(__dirname, 'prof', 'detfix', `attrib_report_${FRAMES}.json`);
  fs.writeFileSync(outFile, JSON.stringify(out, null, 2));
  console.log(JSON.stringify({ ok: true, out: outFile, recCalls: out.recCalls, repCalls: out.repCalls,
    firstDivergence: out.firstDivergence, recTop: out.recTop.slice(0, 8), repTop: out.repTop.slice(0, 8) }, null, 2));
})().catch((e) => { console.error('FAILED:', (e && e.stack) || e); process.exitCode = 1; });
