#!/usr/bin/env node
'use strict';
/* ============================================================================
 * 探针（只读产品代码；本文件是新建探针）：**真实对局**里 JS 融合判死 vs Rust 判死
 *
 *   被审计者：vantage_1（Vantage 树自己的车，选路影响到它）与 tank_a（站桩目标）
 *   每 K 帧，在**真实世界状态**下取该车真实位姿，对同一批 9 个候选操作跑两条路：
 *     JS   : adapter.simulateTankBatchJsFused(...)        （死亡权威，v153 有几何补判）
 *     Rust : adapter.simulateTankBatchScored(...)        （树 rolloutNine 实际用的快路）
 *   两条路都从同一次 0 帧融合预摆位出发（Rust 内部就是这么取的），所以输入完全相同。
 *
 *   为避免污染树自己的融合世界/Rust 世界：审计用**独立 aiId 的代理 gameController**
 *   （key = jr_vantage / jr_human），fused 世界与 Rust cacheId 都与树分开。
 *
 * 用法：node _tools/headless/_probe_jr_death_real.js [--frames 6000] [--every 6] [--out x.json]
 * ============================================================================ */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Match } = require('./match');

function arg(n, d) { const i = process.argv.indexOf('--' + n); return i < 0 ? d : Number(process.argv[i + 1]); }
const FRAMES = arg('frames', 6000);
const EVERY = arg('every', 6);
const MODE = process.argv.includes('--mode') ? process.argv[process.argv.indexOf('--mode') + 1] : 'real';
const MIN_D = arg('mind', 3.0), MAX_D = arg('maxd', 12.0);
const ENR_BUCKET = process.argv.includes('--bucket') ? process.argv[process.argv.indexOf('--bucket') + 1] : 'approach';
const OUT = process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1]
  : path.join(__dirname, 'prof', 'probe_jr_real_report.json');
const T0 = Date.now();
const T = () => ((Date.now() - T0) / 1000).toFixed(1) + 's';

const FILES = [
  'game_core/js/vantage_sandbox.js', 'game_core/js/vantage_tree.js', 'game_core/js/vantage_scoring.js',
  'game_core/js/vantage_rust_bridge.js', 'game_core/js/wasm/vantage_core.wasm',
  'game_core/rust/vantage_core/src/rollout.rs', 'game_core/rust/vantage_core/src/rescore.rs',
  'game_core/index.html', '_tools/headless/clock.js', '_tools/headless/match.js'
];
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

const PAGE_SRC = `
window.__jrWarns = [];
if (!window.__jrWarnHooked) {
  window.__jrWarnHooked = true;
  var __jrOw = console.warn;
  console.warn = function () {
    try { window.__jrWarns.push(Array.prototype.slice.call(arguments).join(' ').slice(0, 400));
          if (window.__jrWarns.length > 60) window.__jrWarns.shift(); } catch (e) {}
    return __jrOw.apply(console, arguments);
  };
}
window.__jr = {
  A: { batches: 0, ops: 0, rustUsed: 0, rustFallback: 0, jsFail: 0,
       jsOnly: 0, rustOnly: 0, bothDead: 0, bothAlive: 0, geoFallback: 0,
       batchesWithJsOnly: 0, batchesWithRustOnly: 0, dfDiff: [],
       rustBestJsDead: 0, rustBestSamples: 0, rustAliveExistJsDead: 0, byBucket: {},
       batchesWithRustAlive: 0, byVictim: {}, examples: [], bulletTypes: {},
       errs: [] },
  adapters: {},
  prep: function () {
    var gc = GameManager.getGameController();
    if (!gc) return { err: 'no gc' };
    var self = this;
    function mk(realId, key) {
      var proxy = {
        getMaze: function () { return gc.getMaze(); },
        getTank: function () { return gc.getTank(realId); },
        getTanks: function () { return gc.getTanks(); },
        getProjectiles: function () { return gc.getProjectiles(); },
        getB2DWorld: function () { return gc.getB2DWorld(); },
        getRoundState: function () { return gc.getRoundState ? gc.getRoundState() : null; }
      };
      var ad = VantageSandbox.createAdapter(proxy, key);
      try { ad.setFrameDtSec(VantageSandbox.getFrameDtSec()); } catch (e) {}
      return ad;
    }
    try {
      this.adapters['vantage_1'] = mk('vantage_1', 'jr_vantage');
      this.adapters['tank_a'] = mk('tank_a', 'jr_human');
    } catch (e) { return { err: String(e && e.message || e) }; }
    this.dt = VantageSandbox.getFrameDtSec();
    this.rustOk = VantageSandbox.rustFrameDtCompatible();
    return { dt: this.dt, rustOk: this.rustOk, tanks: Object.keys(this.adapters),
             tree: (typeof VantageTree !== 'undefined') ? VantageTree.VERSION : null };
  },
  bulletInv: function (gc, pose) {
    var out = {}, near = 0, ps = gc.getProjectiles();
    for (var k in ps) {
      var p = ps[k]; if (!p || (p.done && p.done())) continue;
      var b = p.getB2DBody ? p.getB2DBody() : null; if (!b || !b.IsActive()) continue;
      var bp = b.GetPosition(), v = b.GetLinearVelocity();
      var r = null; try { r = b.GetFixtureList().GetShape().m_radius; } catch (e) {}
      var ty = p.getType ? p.getType() : '?';
      var key = 'ty' + ty + '_r' + r;
      out[key] = (out[key] || 0) + 1;
      var d = Math.hypot(bp.x - pose.x, bp.y - pose.y);
      if (d < 8) near++;
    }
    return { types: out, near8: near };
  },
  _rot: { n: 0, s: 12345 },
  _rnd: function () { this._rot.s = (this._rot.s * 1664525 + 1013904223) >>> 0; return this._rot.s / 4294967296; },
  initDist: function (pose) {
    var gc = GameManager.getGameController(); var ps = gc.getProjectiles(); var best = null;
    for (var k in ps) { var p = ps[k]; if (!p || (p.done && p.done())) continue; var b = p.getB2DBody ? p.getB2DBody() : null;
      if (!b || !b.IsActive()) continue; var bp = b.GetPosition(); var d = Math.hypot(bp.x - pose.x, bp.y - pose.y);
      if (best === null || d < best) best = d; }
    return best;
  },
  enrich: function (victimId, minD, maxD, mode) {
    var gc = GameManager.getGameController();
    var ps = gc.getProjectiles();
    var cands = [];
    for (var k in ps) {
      var p = ps[k]; if (!p || (p.done && p.done())) continue;
      var b = p.getB2DBody ? p.getB2DBody() : null; if (!b || !b.IsActive()) continue;
      var v = b.GetLinearVelocity(); var sp = v.Length(); if (!(sp > 1)) continue;
      var ty = p.getType ? p.getType() : -99;
      cands.push({ key: k, p: b.GetPosition(), vx: v.x, vy: v.y, sp: sp, ty: ty });
    }
    if (!cands.length) return { err: 'no bullet' };
    this._rot.n++;
    var c = cands[this._rot.n % cands.length];
    var t0 = gc.getTank(victimId); if (!t0) return { err: 'no victim' };
    this._prev = { id: victimId, x: t0.getX(), y: t0.getY(), rot: t0.getRotation() };
    var ux = c.vx / c.sp, uy = c.vy / c.sp;
    var nx = -uy, ny = ux;
    // 距离：慢弹要近一点才有 75 帧内到达；激光(180m/s)随意
    var framesToArrive = (minD + (maxD - minD) * this._rnd()) / c.sp * 60;
    var d = (minD + (maxD - minD) * this._rnd());
    var lat = (this._rnd() * 2 - 1) * 2.5;      // 横偏 ±2.5m（含命中/擦边/近失）
    var ang = (this._rnd() * 2 - 1) * Math.PI;  // 车头方向随机
    var x = c.p.x + ux * d + nx * lat, y = c.p.y + uy * d + ny * lat;
    if (mode === 'contact') { x = c.p.x; y = c.p.y; }           // 直接摆到弹上（初始重叠类）
    else { x = Math.round(x / 10) * 10; y = Math.round(y / 10) * 10; }   // 合法格心（避免被墙纠正）
    try {
      var ts = TankState.withState(victimId, x, y, false, false, ang, false, false, false, false);
      var ret = gc.setTankState(ts, false);
      if (ret === false) return { err: 'setTankState false' };
    } catch (e) { return { err: 'tp ' + (e && e.message) }; }
    var t1 = gc.getTank(victimId);
    if (!t1) return { err: 'victim gone' };
    var dRe = Math.hypot(t1.getX() - c.p.x, t1.getY() - c.p.y);
    if (mode !== 'contact' && (Math.abs(t1.getX() - x) > 0.05 || Math.abs(t1.getY() - y) > 0.05)) return { err: 'corrected' };
    if (mode !== 'contact' && dRe < (window.__jrMinD || 3.0)) return { err: 'too close ' + (Math.round(dRe * 100) / 100) };
    return { ok: 1, bulletKey: c.key, ty: c.ty, speed: Math.round(c.sp * 100) / 100, d: Math.round(d * 100) / 100,
             distToBullet: Math.round(dRe * 100) / 100, lat: Math.round(lat * 100) / 100, arriveFrames: Math.round(framesToArrive),
             pose: { x: t1.getX(), y: t1.getY(), rot: t1.getRotation() } };
  },
  restore: function () {
    var v = this._prev; if (!v) return 'none';
    try {
      var gc = GameManager.getGameController();
      var ts = TankState.withState(v.id, v.x, v.y, false, false, v.rot, false, false, false, false);
      gc.setTankState(ts, false);
    } catch (e) { return 'err'; }
    this._prev = null;
    return 'ok';
  },
  audit: function (realId, frames, bucket) {
    bucket = bucket || 'real';
    var ad = this.adapters[realId];
    if (!ad) return { err: 'no adapter' };
    var st = ad.getTankState();
    if (!st || !isFinite(st.x) || !isFinite(st.y) || !isFinite(st.rot)) return { err: 'bad pose' };
    var gc = GameManager.getGameController();
    var pose = { x: st.x, y: st.y, rot: st.rot };
    var ops = ad.operations;
    // cfg 必须显式给 lanePenaltyRatio：缺省时沙箱会取 VantageScoring.DEFAULTS.lanePenaltyRatio=0.5，
    // 而 Rust vt_score_paths 明确拒绝 lane>0（→ 静默回退 JS scorePaths）。树每次都显式传（treeScoringCfg）。
    var opt = { startPose: pose, threats: [], tGlobal: 0, nowTGlobal: 0,
                auditPurpose: 'jsConfirm', cfg: { deathPenalty: 0, lanePenaltyRatio: 0 } };
    var js = null, sum = null, rust = null;
    try { js = ad.simulateTankBatchJsFused(pose, ops, frames, opt); } catch (e) { this.A.jsFail++; return { err: 'js ' + e }; }
    try { sum = ad.getLastFusedBatchSummary(); } catch (e) { sum = null; }
    try { rust = ad.simulateTankBatchScored(pose, ops, frames, opt); } catch (e) { return { err: 'rust ' + e }; }
    if (!rust || rust.length !== ops.length || !(rust[0] && rust[0].rustPhysics)) {
      this.A.rustFallback++;
      this.A.lastWarns = window.__jrWarns.slice(-3);
      if (!this.A.diagOnce) {
        this.A.diagOnce = { rustNull: !rust, rustLen: rust ? rust.length : null,
          rustPhys: rust && rust[0] ? !!rust[0].rustPhysics : null,
          dtOk: (function () { try { return VantageSandbox.rustFrameDtCompatible(); } catch (e) { return 'err'; } })(),
          bridgeReady: !!(window.VantageRustBridge && window.VantageRustBridge._ready),
          fused0: (function () { try { return !!(ad.simulateTankBatchJsFused(pose, ops, 0, { startPose: pose, threats: [], tGlobal: 0, nowTGlobal: 0, auditPurpose: 'jsConfirm', cfg: {} })); } catch (e) { return 'err:' + e; } })(),
          walls: (function () { try { var w = VantageSandbox.getFusedWallShapes(GameManager.getGameController(), realId); return w ? w.length : null; } catch (e) { return 'err'; } })(),
          warns: window.__jrWarns.slice(-6),
          variants: (function () {
            var out = {};
            function t(name, cfg, useThreats, useScored) {
              try {
                var o2 = { startPose: pose, threats: [], tGlobal: 0, nowTGlobal: 0, auditPurpose: 'jsConfirm', cfg: cfg };
                var rr = useScored ? ad.simulateTankBatchScored(pose, ops, 75, o2)
                                   : ad.simulateTankBatch(pose, ops, 75, o2);
                out[name] = rr ? (rr.length + '/' + (rr[0] && rr[0].rustPhysics ? 'rust' : 'js')) : 'null';
              } catch (e) { out[name] = 'throw:' + (e && e.message); }
            }
            t('scored_cfgEmpty', {}, false, true);
            t('scored_cfgNoOccl', { deathPenalty: 0, occlusionEnabled: false }, false, true);
            t('scored_cfgTreeLike', { deathPenalty: 0, lanePenaltyRatio: 0 }, false, true);
            t('plainRollout', {}, false, false);
            t('plainRollout_cfgEmpty', {}, false, false);
            return out;
          })()
        };
      }
      return { err: 'rust fallback' };
    }
    if (!js || js.length !== ops.length) { this.A.jsFail++; return { err: 'js batch' }; }
    this.A.rustUsed++;
    var inv = this.bulletInv(gc, pose);
    var iDist = this.initDist(pose);
    var BK = this.A.byBucket[bucket] || (this.A.byBucket[bucket] = { batches: 0, ops: 0, jsOnly: 0, rustOnly: 0,
      bothDead: 0, bothAlive: 0, dfDiff: [], initDistMin: null, initDistMax: null, df0JsOnly: 0, lastFrameJsOnly: 0 });
    BK.batches++;
    if (iDist !== null) { BK.initDistMin = (BK.initDistMin === null) ? iDist : Math.min(BK.initDistMin, iDist);
                          BK.initDistMax = (BK.initDistMax === null) ? iDist : Math.max(BK.initDistMax, iDist); }
    for (var k in inv.types) this.A.bulletTypes[k] = (this.A.bulletTypes[k] || 0) + inv.types[k];
    var A = this.A, nJsOnly = 0, nRustOnly = 0, anyAlive = false, anyAliveJsDead = false;
    var worst = null;
    for (var i = 0; i < ops.length; i++) {
      var jd = !!js[i].dead, rd = !!rust[i].dead, jdf = js[i].deathFrame, rdf = rust[i].deathFrame;
      A.ops++;
      BK.ops++;
      if (jd && !rd) { A.jsOnly++; nJsOnly++; if (!worst) worst = i; BK.jsOnly++;
                       if (jdf === 0) BK.df0JsOnly++; else if (jdf >= 75) BK.lastFrameJsOnly++;
                       else { (BK.jsOnlyOtherDf = BK.jsOnlyOtherDf || []).push(jdf); (A.jsOnlyOtherDf = A.jsOnlyOtherDf || []).push(jdf); } }
      else if (!jd && rd) { A.rustOnly++; nRustOnly++; BK.rustOnly++; (A.rustOnlyDfList = A.rustOnlyDfList || []).push(rdf); }
      else if (jd && rd) { A.bothDead++; BK.bothDead++; if (jdf !== rdf) { A.dfDiff.push(jdf - rdf); BK.dfDiff.push(jdf - rdf); } }
      else { A.bothAlive++; BK.bothAlive++; }
      if (!rd) { anyAlive = true; if (jd) anyAliveJsDead = true; }
    }
    // “选路代理”：Rust 侧打分最高的那个操作，JS 是否判死
    var bi = -1, bs = -Infinity;
    for (var q = 0; q < rust.length; q++) { var sc = (typeof rust[q].totalScore === 'number') ? rust[q].totalScore : -Infinity; if (sc > bs) { bs = sc; bi = q; } }
    if (bi >= 0) { A.rustBestSamples++; if (js[bi].dead) A.rustBestJsDead++; }
    if (anyAlive) { A.batchesWithRustAlive++; if (anyAliveJsDead) A.rustAliveExistJsDead++; }
    if (sum && sum.geometryFallback) A.geoFallback++;
    if (nJsOnly) A.batchesWithJsOnly++;
    if (nRustOnly) A.batchesWithRustOnly++;
    A.batches++;
    var bv = A.byVictim[realId] || (A.byVictim[realId] = { batches: 0, ops: 0, jsOnly: 0, rustOnly: 0, rustBestJsDead: 0 });
    bv.batches++; bv.ops += ops.length; bv.jsOnly += nJsOnly; bv.rustOnly += nRustOnly;
    if (bi >= 0 && js[bi].dead) bv.rustBestJsDead++;
    if ((nJsOnly || nRustOnly) && A.examples.length < 10) {
      A.examples.push({ victim: realId, op: (worst === null ? -1 : ops[worst].name), jsOnly: nJsOnly, rustOnly: nRustOnly,
        jsDF: js.map(function (r) { return r.dead ? r.deathFrame : -1; }),
        rustDF: rust.map(function (r) { return r.dead ? r.deathFrame : -1; }),
        pose: { x: Math.round(pose.x * 100) / 100, y: Math.round(pose.y * 100) / 100, rot: Math.round(pose.rot * 100) / 100 },
        bullets: inv, geo: sum ? !!sum.geometryFallback : null,
        overlapNoContact: sum && sum.overlapNoContact ? sum.overlapNoContact.length : 0 });
    }
    return { ok: 1, jsOnly: nJsOnly, rustOnly: nRustOnly };
  },
  treeStats: function () {
    try {
      var t = VantageTree.getTree();
      if (!t) return { noTree: true };
      var h = (t.diag && t.diag.structureHistory) ? t.diag.structureHistory : [];
      var conf = [];
      for (var i = 0; i < h.length; i++) if (h[i].code === 'js-death-confirm' || h[i].code === 'js-death-confirm-fail') conf.push({ code: h[i].code, detail: h[i].detail, t: h[i].t });
      return { stats: JSON.parse(JSON.stringify(t.stats || {})), confirms: conf.slice(-40), confirmTotal: conf.length,
               diagKeys: t.diag ? Object.keys(t.diag) : [] };
    } catch (e) { return { err: String(e && e.message || e) }; }
  }
};
'ready';
`;

(async () => {
  const report = { fingerprints: fingerprints(), files: FILES, frames: FRAMES, every: EVERY, mode: MODE, mind: MIN_D, maxd: MAX_D, steps: [] };
  const m = new Match();
  try {
    await m.open({ humanIds: ['tank_a'], aiCount: 1, vantCount: 1 });
    console.log(`[${T()}] 开局:`, JSON.stringify(m.bootstrap));
    const prep = await m.eval(PAGE_SRC + `
      (function () {
        var r = window.__jr.prep();
        window.__jrBoost = { install: false };
        try { window.__jrBoost.install = !!window.__vtInstallControl('tank_a'); } catch (e) { window.__jrBoost.err = String(e); }
        return r;
      })()`);
    console.log(`[${T()}] 审计器:`, JSON.stringify(prep));
    report.prep = prep;
    if (prep && prep.err) throw new Error('prep failed: ' + prep.err);
    if (!prep.rustOk) throw new Error('rustFrameDtCompatible = false —— Rust 快路没启用，本次测不了');

    // 单轮内：每 EVERY 帧审计一次；轮结束/换轮自动继续
    const CHUNK = EVERY;
    let doneFrames = 0, audits = 0, roundEnds = 0, ctrlFails = 0; const enrichErrs = {};
    const plan = ['fwd', 'fwd+left', 'fwd+right', 'fwd', 'back+left', 'fwd+right', 'fwd', 'static'];
    let pi = 0;
    while (doneFrames < FRAMES) {
      pi = Math.floor(doneFrames / 45) % plan.length;
      const p = plan[pi];
      const ctrl = { fwd: p.indexOf('fwd') >= 0, back: p.indexOf('back') >= 0,
        left: p.indexOf('left') >= 0, right: p.indexOf('right') >= 0, fire: (Math.floor(doneFrames / 90) % 3) === 0 };
      try { await m.setControl(ctrl); } catch (eCtrl) { ctrlFails++; }
      await m.pump(CHUNK, { yieldMs: 0 });
      doneFrames += CHUNK;
      let r;
      if (MODE === 'enriched') {
        // 富集：把 tank_a 摆到真实子弹弹道前方（真弹/真图/真坦克，人为摆位），审计后摆回
        const bucket = (typeof ENR_BUCKET !== 'undefined') ? ENR_BUCKET : 'approach';
        r = await m.eval(`(function(){
          var o = {};
          var en = window.__jr.enrich('vantage_1', ${MIN_D}, ${MAX_D}, '${bucket}');
          if (en && en.ok) {
            var a = window.__jr.audit('vantage_1', 75, '${bucket}');
            o.place = { bucket: '${bucket}', ty: en.ty, speed: en.speed, d: en.d, distToBullet: en.distToBullet, arriveFrames: en.arriveFrames };
            o.audit = a;
          } else { o.enrichErr = en && en.err; }
          window.__jr.restore();   // ★ 必须无条件摆回：否则把 AI 车留在弹上 = 自杀 + 掉进回合空档
          return o;
        })()`);
        audits += (r && r.audit && r.audit.ok ? 1 : 0);
        if (r && r.enrichErr) {
          enrichErrs[r.enrichErr] = (enrichErrs[r.enrichErr] || 0) + 1;
          if (r.enrichErr === 'no victim' || r.enrichErr === 'no bullet') {
            try { await m.waitForRound({ maxFrames: 400 }); } catch (eW) {}
          }
        }
      } else {
        r = await m.eval(`(function(){ var o=[]; var ids=Object.keys(window.__jr.adapters);
          for (var i=0;i<ids.length;i++){ try { o.push(window.__jr.audit(ids[i], 75)); } catch(e){ o.push({err:String(e&&e.message||e)}); } } return o; })()`);
        audits += (r && r.filter(x => x && x.ok).length) || 0;
        if (r && r.some(x => x && x.err && /bad pose|no adapter/.test(x.err))) {
          roundEnds++;
          try { await m.waitForRound({ maxFrames: 900 }); } catch (eWait) { }
        }
      }
      if (doneFrames % 600 === 0) {
        const st = await m.eval('window.__vt.steps');
        console.log(`[${T()}] frames=${doneFrames} vt.steps=${st} audits=${audits}`);
      }
    }
    report.auditFrames = doneFrames;
    report.roundEndish = roundEnds;
    report.ctrlFails = ctrlFails;
    report.enrichErrs = enrichErrs;
    report.audits = audits;
    const A = await m.eval('(function(){ var a = window.__jr.A; a.dfDiff = a.dfDiff.slice(0, 4000); a.jsOnlyOtherDf = (a.jsOnlyOtherDf||[]).slice(0,400); a.rustOnlyDfList = (a.rustOnlyDfList||[]).slice(0,400); return a; })()');
    report.audit = A;
    const ts = await m.eval('window.__jr.treeStats()');
    report.tree = ts;
    try { report.vtStats = await m.stats(); } catch (e) { report.vtStats = null; }
    try { report.pageErrors = m.pageErrors.slice(0, 5); } catch (e) {}
    const D = (A.dfDiff || []).slice().sort((a, b) => a - b);
    report.dfDiffSummary = D.length ? { n: D.length, min: D[0], p50: D[Math.floor(D.length / 2)], p90: D[Math.floor(D.length * 0.9)], max: D[D.length - 1], avg: +(D.reduce((a, b) => a + b, 0) / D.length).toFixed(2) } : null;
    console.log(`[${T()}] ===== 审计汇总 =====`);
    console.log(JSON.stringify({ batches: A.batches, ops: A.ops, jsOnly: A.jsOnly, rustOnly: A.rustOnly,
      bothDead: A.bothDead, bothAlive: A.bothAlive, rustFallback: A.rustFallback, jsFail: A.jsFail,
      geoFallback: A.geoFallback, rustBestJsDead: A.rustBestJsDead, rustBestSamples: A.rustBestSamples, sceneBuckets: A.sceneBuckets,
      batchesWithRustAlive: A.batchesWithRustAlive, rustAliveExistJsDead: A.rustAliveExistJsDead,
      byVictim: A.byVictim, dfDiff: report.dfDiffSummary, treeStats: ts && ts.stats }, null, 1));
    fs.writeFileSync(OUT, JSON.stringify(report, null, 1));
    console.log(`[${T()}] 报告 -> ${OUT} (${(fs.statSync(OUT).size / 1024).toFixed(1)} KB)`);
  } catch (e) {
    console.error('FAILED:', (e && e.stack) || e);
    process.exitCode = 1;
    try { fs.writeFileSync(OUT, JSON.stringify(Object.assign({ fatal: String((e && e.stack) || e) }, report), null, 1)); } catch (e2) {}
  } finally { try { await m.close(); } catch (e) {} }
})();
