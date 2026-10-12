#!/usr/bin/env node
'use strict';
/* ============================================================================
 * 探针（只读产品代码；本文件是新建探针）：**挂在树自己的调用上**对拍 JS vs Rust
 *
 *   VantageTree.rolloutNine 每 tick 调 adapter.simulateTankBatchScored(...)（Rust 快路）
 *   本探针在浏览器里把 VantageSandbox.createAdapter 包一层（只记录，不改返回值）：
 *     对每一次树的 Rust 批次，用**完全相同的 state/ops/frames/opt**
 *     （含真实 threats / tGlobal / nowTGlobal）再跑一遍 JS 融合，
 *     逐 op 比 dead/deathFrame。
 *   ⟹ 这是"树真正看过的局面"的无偏样本（不是我们自己造的场面）。
 *
 * 用法：node _tools/headless/_probe_jr_death_tree.js [--frames 3000]
 * ============================================================================ */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Match } = require('./match');

function arg(n, d) { const i = process.argv.indexOf('--' + n); return i < 0 ? d : Number(process.argv[i + 1]); }
const FRAMES = arg('frames', 3000);
const OUT = process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1]
  : path.join(__dirname, 'prof', 'probe_jr_tree_report.json');
const T0 = Date.now();
const T = () => ((Date.now() - T0) / 1000).toFixed(1) + 's';
const FILES = ['game_core/js/vantage_sandbox.js', 'game_core/js/vantage_tree.js', 'game_core/js/vantage_rust_bridge.js',
  'game_core/js/wasm/vantage_core.wasm', 'game_core/rust/vantage_core/src/rollout.rs',
  'game_core/js/vantage_scoring.js', 'game_core/index.html', '_tools/headless/clock.js', '_tools/headless/match.js'];
function fingerprints() {
  const out = [];
  for (const rel of FILES) {
    const p = path.join(__dirname, '..', '..', rel);
    try {
      const st = fs.statSync(p);
      out.push({ file: rel, bytes: st.size, mtime: st.mtime.toISOString(),
        md5: crypto.createHash('md5').update(fs.readFileSync(p)).digest('hex') });
    } catch (e) { out.push({ file: rel, err: String(e.message || e) }); }
  }
  return out;
}

const HOOK_SRC = `
window.__jrt = {
  A: { batches: 0, ops: 0, jsOnly: 0, rustOnly: 0, bothDead: 0, bothAlive: 0, dfDiff: [],
       jsOnlyDf0: 0, jsOnlyLastFrame: 0, jsOnlyOther: 0, rustOnlyDf0: 0,
       rustBestJsDead: 0, rustBestSamples: 0, rustAliveOps: 0, jsDeadOps: 0,
       batchesWithJsOnly: 0, batchScenes: 0, examples: [], errs: [],
       hooks: 0, jsBatchNull: 0, framesUsed: {} },
  install: function () {
    if (this.installed) return 'already';
    this.installed = true;
    var self = this;
    var orig = VantageSandbox.createAdapter;
    window.__jrtOrig = orig;
    self.patchAdapter = function (ad) {
      if (!ad || ad.__jrWrapped) return false;
      var origScored = ad.simulateTankBatchScored;
      if (typeof origScored !== 'function') return false;
      ad.__jrWrapped = true;
      self.hooks++;
      ad.simulateTankBatchScored = function (state, ops, frames, opt) {
        var rust = origScored.apply(ad, arguments);
        try { self.compare(ad, state, ops, frames, opt, rust); } catch (eComp) {
          self.A.errs.push(String(eComp && eComp.message || eComp).slice(0, 120));
          if (self.A.errs.length > 20) self.A.errs.shift();
        }
        return rust;
      };
      return true;
    };
    VantageSandbox.createAdapter = function (gc, aiId) {
      var ad = orig.apply(this, arguments);
      self.patchAdapter(ad);
      return ad;
    };
    // 树的适配器是 AI 实例上缓存的（ai_vantage.js: this._vantageAdapter），
    // 页面开局时早就建好了 —— 必须把已存在的那个也包上。
    try {
      var mgrs = (typeof AIs !== 'undefined' && AIs.aiManagers) ? AIs.aiManagers : [];
      for (var i = 0; i < mgrs.length; i++) {
        var mgr = mgrs[i];
        self.patchAdapter(mgr && mgr.ai && mgr.ai._vantageAdapter);
        for (var k in mgr) { try { if (mgr[k] && mgr[k]._vantageAdapter) self.patchAdapter(mgr[k]._vantageAdapter); } catch (eK) {} }
      }
    } catch (eMgr) { self.A.errs.push('mgr:' + String(eMgr && eMgr.message)); }
    return 'installed';
  },
  compare: function (ad, state, ops, frames, opt, rust) {
    var A = this.A;
    if (!ops || !ops.length || !(frames > 0)) return;
    if (!rust || rust.length !== ops.length || !(rust[0] && rust[0].rustPhysics)) return;   // 只有真走 Rust 的批次才算
    A.batches++;
    var jopt = {}; for (var k in opt) { if (Object.prototype.hasOwnProperty.call(opt, k)) jopt[k] = opt[k]; }
    jopt.auditPurpose = 'hookAudit';   // 不开几何审计（省时间），几何回溯补判本身照跑
    var js = null;
    try { js = ad.simulateTankBatchJsFused(state, ops, frames, jopt); } catch (eJs) { js = null; }
    if (!js || js.length !== ops.length) { A.jsBatchNull++; return; }
    A.framesUsed[frames] = (A.framesUsed[frames] || 0) + 1;
    var nJsOnly = 0, nRustOnly = 0, sceneBad = false;
    for (var i = 0; i < ops.length; i++) {
      var jd = !!js[i].dead, rd = !!rust[i].dead, jdf = js[i].deathFrame, rdf = rust[i].deathFrame;
      A.ops++;
      if (!rd) { A.rustAliveOps++; if (jd) A.jsDeadOps++; }
      if (jd && !rd) {
        A.jsOnly++; nJsOnly++; sceneBad = true;
        if (jdf === 0) A.jsOnlyDf0++; else if (jdf >= frames) A.jsOnlyLastFrame++; else A.jsOnlyOther++;
      } else if (!jd && rd) {
        A.rustOnly++; nRustOnly++; sceneBad = true;
        if (rdf === 0) A.rustOnlyDf0++;
      } else if (jd && rd) { A.bothDead++; if (jdf !== rdf) A.dfDiff.push(jdf - rdf); }
      else A.bothAlive++;
    }
    if (nJsOnly) A.batchesWithJsOnly++;
    var bi = -1, bs = -Infinity;
    for (var q = 0; q < rust.length; q++) {
      var sc = (typeof rust[q].totalScore === 'number') ? rust[q].totalScore : -Infinity;
      if (sc > bs) { bs = sc; bi = q; }
    }
    if (bi >= 0) { A.rustBestSamples++; if (js[bi].dead) A.rustBestJsDead++; }
    if (sceneBad && A.examples.length < 12) {
      A.examples.push({ opName: (bi >= 0 && ops[bi]) ? ops[bi].name : null,
        jsDF: js.map(function (r) { return r.dead ? r.deathFrame : -1; }),
        rustDF: rust.map(function (r) { return r.dead ? r.deathFrame : -1; }),
        start: { x: Math.round(state.x * 100) / 100, y: Math.round(state.y * 100) / 100, rot: Math.round(state.rot * 100) / 100 },
        tGlobal: (typeof opt.tGlobal === 'number') ? Math.round(opt.tGlobal * 1000) / 1000 : null,
        nThreats: (opt.threats || []).length, frames: frames,
        rustBest: bi, rustBestDeadJs: bi >= 0 ? !!js[bi].dead : null });
    }
  },
  treeStats: function () {
    try {
      var t = VantageTree.getTree();
      if (!t) return { noTree: true };
      var h = (t.diag && t.diag.structureHistory) ? t.diag.structureHistory : [];
      var conf = [];
      for (var i = 0; i < h.length; i++) if (h[i].code === 'js-death-confirm' || h[i].code === 'js-death-confirm-fail') conf.push(h[i].detail);
      return { stats: JSON.parse(JSON.stringify(t.stats || {})), confirms: conf.slice(-60),
               confirmTotal: conf.length };
    } catch (e) { return { err: String(e && e.message || e) }; }
  }
};
'ready';
`;

(async () => {
  const report = { fingerprints: fingerprints(), frames: FRAMES, steps: [] };
  const m = new Match();
  try {
    await m.open({ humanIds: ['tank_a'], aiCount: 1, vantCount: 1 });
    console.log(`[${T()}] 开局:`, JSON.stringify(m.bootstrap));
    const inst = await m.eval(HOOK_SRC + ' window.__jrt.install()');
    console.log(`[${T()}] 钩子:`, inst, 'rustDtOk=', await m.eval('VantageSandbox.rustFrameDtCompatible()'));
    report.install = inst;
    report.dt = await m.eval('VantageSandbox.getFrameDtSec()');
    const CHUNK = 30;
    let done = 0;
    while (done < FRAMES) {
      await m.pump(CHUNK, { yieldMs: 0 });
      done += CHUNK;
      if (done % 600 === 0) {
        const s = await m.eval('JSON.stringify({b:window.__jrt.A.batches,ops:window.__jrt.A.ops,jsOnly:window.__jrt.A.jsOnly,df0:window.__jrt.A.jsOnlyDf0,last:window.__jrt.A.jsOnlyLastFrame,other:window.__jrt.A.jsOnlyOther,rustOnly:window.__jrt.A.rustOnly,steps:window.__vt.steps})');
        console.log(`[${T()}] frames=${done} ${s}`);
      }
    }
    const A = await m.eval('(function(){ var a = window.__jrt.A; a.dfDiff = a.dfDiff.slice(0, 4000); return a; })()');
    const ts = await m.eval('window.__jrt.treeStats()');
    report.audit = A; report.tree = ts;
    report.auditFrames = done;
    try { report.vtStats = await m.stats(); } catch (e) { report.vtStats = null; }
    const D = (A.dfDiff || []).slice().sort((a, b) => a - b);
    report.dfDiffSummary = D.length ? { n: D.length, min: D[0], p50: D[Math.floor(D.length / 2)], p90: D[Math.floor(D.length * 0.9)], max: D[D.length - 1] } : null;
    console.log(`[${T()}] ===== 汇总 =====`);
    console.log(JSON.stringify({ batches: A.batches, ops: A.ops, jsOnly: A.jsOnly, jsOnlyDf0: A.jsOnlyDf0,
      jsOnlyLastFrame: A.jsOnlyLastFrame, jsOnlyOther: A.jsOnlyOther, rustOnly: A.rustOnly, rustOnlyDf0: A.rustOnlyDf0,
      bothDead: A.bothDead, bothAlive: A.bothAlive, batchesWithJsOnly: A.batchesWithJsOnly,
      rustBestJsDead: A.rustBestJsDead, rustBestSamples: A.rustBestSamples,
      rustAliveOps: A.rustAliveOps, jsDeadOps: A.jsDeadOps, jsBatchNull: A.jsBatchNull, hooks: A.hooks,
      framesUsed: A.framesUsed, dfDiff: report.dfDiffSummary, errs: A.errs.slice(0, 5),
      tree: ts && ts.stats }, null, 1));
    console.log('树自己的 jsConfirm 记录（fd 变化）:');
    console.log(JSON.stringify((ts.confirms || []).filter(s => s.indexOf('fd -1') < 0).slice(-20)));
    fs.writeFileSync(OUT, JSON.stringify(report, null, 1));
    console.log(`[${T()}] 报告 -> ${OUT} (${(fs.statSync(OUT).size / 1024).toFixed(1)} KB)`);
  } catch (e) {
    console.error('FAILED:', (e && e.stack) || e);
    process.exitCode = 1;
    try { fs.writeFileSync(OUT, JSON.stringify(Object.assign({ fatal: String((e && e.stack) || e) }, report), null, 1)); } catch (e2) {}
  } finally { try { await m.close(); } catch (e) {} }
})();
