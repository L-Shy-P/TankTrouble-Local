'use strict';
/* 多 vantage AI 树时钟探针（2026-10-12 新任务自用；只读包装，不改 game_core）
 *
 *   node _tools/headless/_probe_multiai_clock.js --vant 1 --frames 480 --tag before_n1
 *
 * 量什么：
 *   · 每帧每个 VantageTree.tick 的：进入时刻 Date.now()/performance.now()、
 *     gc.lastUpdate 毫秒、rawWall=Date.now()-lastUpdate、tick 前后 _timeAcc 增量
 *   · 每帧 gc.update 次数 / RoundModel.update 次数（世界步）/ 是否 _frozen
 *   · dumpDiagnostics().liveAnchors（只读；用于对照 Δ 的斜率）
 * 判据（Node 侧汇总）：
 *   ratio = Σ(Δ_timeAcc) / Σ(Δ虚拟游戏秒)   —— 只统计"世界刚好 Step 了一次且未冻结"的帧
 *   ticksPerFrame = 同一游戏帧内 tick 了几次
 */
const fs = require('fs');
const path = require('path');
const { Match } = require('./match');

const INSTALL = `(() => {
  try {
    if (!window.__mc) {
      window.__mc = { ticks: 0, gcUpd: 0, steps: 0, tickLog: [], tickPatched: false, gcPatched: false, rmPatched: false };
      var origTick = VantageTree.tick;
      VantageTree.tick = function (ai, dt) {
        var gc = ai && ai.gameController ? ai.gameController : null;
        var lu = gc ? gc.lastUpdate : null;
        var luMs = (lu && typeof lu.getTime === 'function') ? lu.getTime() : ((typeof lu === 'number') ? lu : null);
        var nowMs = Date.now();
        var before = (VantageTree._coarse && VantageTree._coarse.getTimeAcc) ? VantageTree._coarse.getTimeAcc() : null;
        var r = origTick.apply(this, arguments);
        var after = (VantageTree._coarse && VantageTree._coarse.getTimeAcc) ? VantageTree._coarse.getTimeAcc() : null;
        window.__mc.ticks++;
        window.__mc.tickLog.push({ nowMs: nowMs, luMs: luMs,
          rawWallMs: (luMs === null) ? null : (nowMs - luMs),
          adv: (before !== null && after !== null) ? (after - before) : null });
        return r;
      };
      // ⚠ 本 build 的 Classy 类没有 prototype（探针实测 GameController.prototype===undefined），
      //   必须包【实例方法】。
      var gc0 = (typeof GameManager !== 'undefined' && GameManager.getGameController) ? GameManager.getGameController() : null;
      if (gc0 && typeof gc0.update === 'function' && !gc0.__mcPatched) {
        var origGc = gc0.update;
        gc0.update = function () { window.__mc.gcUpd++; return origGc.apply(this, arguments); };
        gc0.__mcPatched = true; window.__mc.gcPatched = true;
      }
      var rm0 = gc0 && gc0.roundController && gc0.roundController.model;
      if (rm0 && typeof rm0.update === 'function' && !rm0.__mcPatched) {
        var origRm = rm0.update;
        rm0.update = function (dt) { if (this.running) window.__mc.steps++; return origRm.apply(this, arguments); };
        rm0.__mcPatched = true; window.__mc.rmPatched = true;
      }
      window.__mc.tickPatched = true;
    }
    return { ok: true, tickPatched: window.__mc.tickPatched, gcPatched: window.__mc.gcPatched, rmPatched: window.__mc.rmPatched };
  } catch (e) { return { ok: false, err: String(e) }; }
})()`;

const SAMPLE = `(() => {
  var mc = window.__mc || {};
  var gc = GameManager.getGameController();
  var acc = (typeof VantageTree !== 'undefined' && VantageTree._coarse && VantageTree._coarse.getTimeAcc)
    ? VantageTree._coarse.getTimeAcc() : null;
  var lu = gc ? gc.lastUpdate : null;
  var luMs = (lu && typeof lu.getTime === 'function') ? lu.getTime() : ((typeof lu === 'number') ? lu : null);
  var d = null;
  try { if (typeof VantageTree !== 'undefined' && VantageTree.dumpDiagnostics) d = VantageTree.dumpDiagnostics(); } catch (eD) { d = null; }
  var anchors = [];
  if (d && d.liveAnchors) {
    for (var i = 0; i < d.liveAnchors.length && i < 4; i++) {
      var a = d.liveAnchors[i];
      anchors.push({ id: a.id, delta: a.delta, td: a.trackDt, len: a.trackLen, has: a.hasTrack });
    }
  }
  var out = {
    t: window.__vt.t, acc: acc, luMs: luMs,
    ticks: mc.ticks || 0, gcUpd: mc.gcUpd || 0, steps: mc.steps || 0,
    frozen: (typeof VantageTree !== 'undefined' && VantageTree.isFrozen) ? VantageTree.isFrozen() : null,
    state: gc ? gc.getState() : null, roundId: gc ? gc.getRoundId() : null,
    ver: (typeof VantageTree !== 'undefined' && VantageTree.VERSION) ? VantageTree.VERSION : null,
    tickLog: (mc.tickLog || []).slice(), anchors: anchors
  };
  if (mc.tickLog) mc.tickLog.length = 0;
  return out;
})()`;

function stats(arr) {
  if (!arr.length) return null;
  const s = arr.slice().sort((a, b) => a - b);
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
  const med = s.length % 2 ? s[(s.length - 1) >> 1] : (s[(s.length >> 1) - 1] + s[s.length >> 1]) / 2;
  return { n: arr.length, mean: Math.round(mean * 1e6) / 1e6, med: Math.round(med * 1e6) / 1e6, min: s[0], max: s[s.length - 1] };
}

(async () => {
  const argv = process.argv.slice(2);
  const num = (n, d) => { const i = argv.indexOf('--' + n); return i < 0 ? d : Number(argv[i + 1]); };
  const str = (n, d) => { const i = argv.indexOf('--' + n); return i < 0 ? d : argv[i + 1]; };
  const vant = num('vant', 1), ai = num('ai', 0), frames = num('frames', 480);
  const injectStep = argv.indexOf('--inject-step') >= 0;   // 模拟训练模式：每帧人工推进一次精确步数表
  const tag = str('tag', 'vant' + vant);
  const outFile = str('out', path.join(__dirname, 'prof', '_multiai_clock_' + tag + '.jsonl'));

  const m = new Match();
  const rows = [];
  await m.open({ humanIds: ['tank_a'], aiCount: ai, vantCount: vant, rng: 'record' });
  const hook = await m.eval(INSTALL);
  console.log('hook=' + JSON.stringify(hook));

  let prev = null;
  for (let f = 1; f <= frames; f++) {
    if (injectStep) {
      await m.eval('(() => { var rm = GameManager.getGameController().roundController.model;' +
        ' rm._ttStepCount = ' + f + '; rm._ttLastStepDt = ' + (1000 / 60 / 1000) + '; return 1; })()');
    }
    await m.pump(1);
    const s = await m.eval(SAMPLE);
    const ticks = s.ticks - (prev ? prev.ticks : 0);
    const gcUpd = s.gcUpd - (prev ? prev.gcUpd : 0);
    const steps = s.steps - (prev ? prev.steps : 0);
    rows.push({
      f: f, t: s.t, acc: s.acc, luMs: s.luMs, ticks: ticks, gcUpd: gcUpd, steps: steps,
      frozen: s.frozen, state: s.state, roundId: s.roundId, ver: s.ver,
      tickRaw: s.tickLog.map((x) => x.rawWallMs), tickAdv: s.tickLog.map((x) => x.adv),
      anchors: s.anchors
    });
    prev = s;
  }
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');

  // —— 汇总：只统计"世界 Step 恰好 1 次、未冻结、时间戳前进"的帧 ——
  const valid = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i], p = rows[i - 1];
    if (r.steps !== 1 || r.frozen) continue;
    if (!(r.t > p.t)) continue;
    const dAcc = r.acc - p.acc;
    const dT = (r.t - p.t) / 1000;
    valid.push({ f: r.f, dAcc: dAcc, dT: dT, ticks: r.ticks, gcUpd: r.gcUpd, raw: r.tickRaw, adv: r.tickAdv });
  }
  const sumAcc = valid.reduce((a, x) => a + x.dAcc, 0);
  const sumT = valid.reduce((a, x) => a + x.dT, 0);
  const firstAdv = [], allAdv = [], allRaw = [];
  for (const x of valid) {
    if (x.adv.length) firstAdv.push(x.adv[0]);
    for (const a of x.adv) allAdv.push(a);
    for (const w of x.raw) if (w !== null) allRaw.push(w);
  }
  const tickHist = {};
  for (const x of valid) tickHist[x.ticks] = (tickHist[x.ticks] || 0) + 1;
  const res = {
    tag: tag, vant: vant, ai: ai, injectStep: injectStep, frames: rows.length, ver: rows.length ? rows[0].ver : null,
    validFrames: valid.length,
    ticksPerFrameHist: tickHist,
    ratioAcc: Math.round((sumAcc / sumT) * 1e6) / 1e6,
    sumAcc: Math.round(sumAcc * 1e6) / 1e6, sumGameSec: Math.round(sumT * 1e6) / 1e6,
    firstTickAdv: stats(firstAdv), allTickAdv: stats(allAdv), tickRawWallMs: stats(allRaw),
    sample: valid.slice(0, 3).map((x) => ({ f: x.f, dAcc: Math.round(x.dAcc * 1e6) / 1e6, dT: Math.round(x.dT * 1e6) / 1e6, ticks: x.ticks, adv: x.adv, raw: x.raw }))
  };
  console.log(JSON.stringify(res));
  await m.close();
})().catch((e) => { console.error('PROBE FAILED: ' + ((e && e.stack) || e)); process.exitCode = 1; });
