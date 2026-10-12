#!/usr/bin/env node
'use strict';
/* ============================================================================
 * _ev_ 探针（只读；不改产品代码）：【Δ 新口径】+【四路对齐】同帧采样
 *
 *   每帧记录（同一帧内）：
 *     ① dumpDiagnostics().liveAnchors  → Δ = _timeAcc − (rootAbsT + anchorOffset)，含取位是否越界(pxNull)
 *        （同帧还读 diag.anchorProbe 旧快照口径 + anchorProbeAge 作对照）
 *     ② adapter.getProjectiles()      → 真弹 id/位置（真弹还活着吗）
 *     ③ getTree().walk() 全树节点     → status / fullDeathFrame（树自己说死说活）
 *     ④ RoundModel TANK_KILLED 事件   → 游戏判死（victim/killer/projectileId/t）
 *
 * 用法:
 *   node _tools/headless/_ev_align_delta.js --frames=900 --tag=cur
 *   EV_GAME_DIR=<冻结副本> node _tools/headless/_ev_align_delta.js --frames=900 --tag=ev167gate --match=_ev_match
 * ============================================================================ */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const args = process.argv.slice(2);
const num = (n, d) => { const i = args.indexOf('--' + n); return i < 0 ? d : Number(args[i + 1]); };
const getS = (n, d) => { const i = args.indexOf('--' + n); return i < 0 ? d : args[i + 1]; };
const FRAMES = num('frames', 900);
const TAG = getS('tag', 'ev');
const MATCHMOD = getS('match', 'match');
const CTRL = getS('ctrl', 'drive');   // drive = 开车+点射（默认；人类不易早死，威胁持续）；teleport = 旧做法（原地转+开火）
const FIRE = num('fire', 1);          // 0 = 人类不开火（避免自杀式跳弹提前结束回合）
const AI_N = num('ai', 1), VANT_N = num('vant', 2);
const OUT = getS('out', path.join(__dirname, '_ev_logs', 'align_' + TAG + '_rows.json'));
const MD5FILES = [
  'game_core/js/vantage_sandbox.js', 'game_core/js/vantage_tree.js', 'game_core/js/vantage_rust_bridge.js',
  'game_core/js/vantage_scoring.js', 'game_core/js/wasm/vantage_core.wasm',
  'game_core/rust/vantage_core/src/rollout.rs', 'game_core/index.html',
];
const md5 = (f) => { try { return crypto.createHash('md5').update(fs.readFileSync(f)).digest('hex'); } catch (e) { return null; } };

const PAGE_SRC = `(() => {
  if (window.__evA) return 'exists';
  var S = window.__evA = { ok: false, deaths: [], evErr: null };
  try {
    var orig = VantageSandbox.createAdapter;
    VantageSandbox.createAdapter = function () { var a = orig.apply(this, arguments); S.ad = a; return a; };
    S.hookCreateAdapter = true;
  } catch (e) { S.hookErr = String((e && e.message) || e); }
  try {
    GameManager.addRoundEventListener(function (self, id, evt, data) {
      try {
        if (evt === RoundModel._EVENTS.TANK_KILLED) {
          var d = VantageTree.dumpDiagnostics();
          S.deaths.push({ t: d ? d.tNow : null, rootAbsT: d ? d.rootAbsT : null,
            victim: data.getVictimPlayerId(), killer: data.getKillerPlayerId(),
            pid: (data.getDeadlyId ? data.getDeadlyId() : null),
            ptype: (data.getDeadlyType ? data.getDeadlyType() : null) });
        }
      } catch (e) { S.evErr = String((e && e.message) || e); }
    }, S);
    S.ok = true;
  } catch (e2) { S.err = String((e2 && e2.message) || e2); }
  return S.ok ? 'ok' : ('err:' + (S.err || S.hookErr));
})()`;

const SAMPLE = `(() => {
  var o = { ok: false };
  try {
    var d = VantageTree.dumpDiagnostics();
    var t = VantageTree.getTree ? VantageTree.getTree() : null;
    if (!d) return { ok: false, why: 'no-diag' };
    o.ok = true; o.t = d.tNow; o.rootAbsT = d.rootAbsT;
    o.frozen = (VantageTree.isFrozen && VantageTree.isFrozen()) ? 1 : 0;
    o.nLive = d.liveProjectileCount;
    o.nThreats = (d.threats || []).length;
    o.age = (typeof d.anchorProbeAge === 'number') ? d.anchorProbeAge : null;
    o.live = (d.liveAnchors || []).map(function (a) {
      var tdt = (a.trackDt && a.trackDt > 0) ? a.trackDt : 0.0166666667;
      var idx = Math.round(a.delta / tdt);
      return { id: a.id, d: a.delta, off: a.anchorOffset, len: a.trackLen || 0, tdt: tdt,
               hasTrack: a.hasTrack ? 1 : 0, idx: idx, pxNull: (a.hasTrack ? (idx >= (a.trackLen || 0)) : true) };
    });
    o.snap = ((d.diag && d.diag.anchorProbe) || []).map(function (a) {
      return { id: a.id, d: Math.round((d.tNow - a.abs0) * 1000) / 1000, len: a.len || 0 };
    });
    o.rd = d.reanchorDiag ? { reuse: (d.reanchorDiag.perThreat || {}).reuse, blocked: (d.reanchorDiag.perThreat || {}).gateBlocked,
      noOld: (d.reanchorDiag.perThreat || {}).noOld, maxGateDelta: (d.reanchorDiag.perThreat || {}).maxGateDelta } : null;
    o.ev = (d.events || []).slice(-3).map(function (e) { return (e.type || '?') + ':' + String(e.info || '').slice(0, 40); });
    var A = window.__evA;
    if (A && A.ad && A.ad.getProjectiles) {
      try { o.proj = A.ad.getProjectiles().map(function (p) { return { id: p.id, x: p.x, y: p.y }; }); }
      catch (e) { o.projErr = String((e && e.message) || e); }
    }
    try {
      var gc = GameManager.getGameController(); var tk = gc && gc.getTank ? gc.getTank('vantage_1') : null;
      if (tk) o.vtank = { x: tk.getX(), y: tk.getY(), rot: tk.getRotation() };
    } catch (e2) {}
    var st = {}, dead = 0, alive = 0, fds = [];
    if (t && t.walk) {
      t.walk(function (n) {
        if (!n) return;
        var s2 = n.status || '?'; st[s2] = (st[s2] || 0) + 1;
        if (typeof n.fullDeathFrame === 'number') { if (n.fullDeathFrame >= 0) { dead++; fds.push(n.fullDeathFrame); } else alive++; }
      });
    }
    o.st = st; o.nodeDead = dead; o.nodeAlive = alive; o.minFd = fds.length ? Math.min.apply(null, fds) : -1;
  } catch (e) { o.err = String((e && e.message) || e); }
  return o;
})()`;

(async () => {
  const fp0 = {}; MD5FILES.forEach((f) => { fp0[f] = md5(f); });
  const { Match } = require('./' + MATCHMOD);
  const m = new Match();
  const t0 = Date.now();
  const rows = [];
  let ver = null, err = null;
  try {
    await m.open({ humanIds: ['tank_a'], aiCount: AI_N, vantCount: VANT_N });
    const hook = await m.eval(PAGE_SRC);
    ver = await m.eval('(typeof VantageTree !== "undefined") ? VantageTree.VERSION : "none"');
    const adInfo = await m.eval('(() => { var A=window.__evA; return {ok:A.ok, hook:A.hookCreateAdapter, err:A.err||A.hookErr||A.evErr||null}; })()');
    console.log('[' + TAG + '] version=' + ver + ' gameDir=' + (process.env.EV_GAME_DIR || '(real)') + ' hook=' + JSON.stringify(hook) + ' ad=' + JSON.stringify(adInfo));
    for (let f = 0; f < FRAMES; f++) {
      if (CTRL === 'teleport') {
        if (f % 40 === 0) {
          const rot = (f / 40) * 0.35;
          await m.eval(`(() => { var gc = GameManager.getGameController(); var a = gc.getTank ? gc.getTank('tank_a') : null;
            if (a && gc.setTankState) gc.setTankState(TankState.withState('tank_a', a.getX(), a.getY(), false,false, ${rot}, false,false,false,false), false);
            window.__vtCtrl.fire = true; return 1; })()`).catch(() => {});
        }
      } else if (f % 15 === 0) {
        // 每 15 帧换一次驾驶相位（前进/后退/左右转）+ 每 90 帧一次 3 帧点射
        await m.eval(`(() => { var c = window.__vtCtrl; if (!c) return 0;
          var ph = ${Math.floor(f / 15) % 4};
          c.fwd = (ph === 0 || ph === 2); c.back = (ph === 1); c.left = (ph === 3); c.right = (ph === 1);
          return 1; })()`).catch(() => {});
        if (FIRE && f % 90 === 0) await m.eval('window.__vtCtrl ? (window.__vtCtrl.fire = true, 1) : 0').catch(() => {});
      } else if (f % 90 === 3) {
        await m.eval('window.__vtCtrl ? (window.__vtCtrl.fire = false, 1) : 0').catch(() => {});
      }
      await m.pump(1);
      const s = await m.eval(SAMPLE).catch(() => null);
      if (!s || !s.ok) continue;
      s.f = f;
      rows.push(s);
      if (f % 300 === 0) console.log('  [' + TAG + '] f=' + f + ' t=' + (s.t && s.t.toFixed(2)) + ' th=' + (s.live || []).length + ' nLive=' + s.nLive + ' proj=' + (s.proj ? s.proj.length : -1) + (s.projErr ? ' projErr=' + s.projErr : ''));
    }
    try { await m.clearControl(); } catch (e) {}
    const evA = await m.eval('window.__evA ? {deaths: window.__evA.deaths, evErr: window.__evA.evErr} : null').catch(() => null);
    const deaths = (evA && evA.deaths) || [];
    const fp1 = {}; MD5FILES.forEach((f) => { fp1[f] = md5(f); });

    // ---------- 汇总 ----------
    const all = rows.filter((r) => r.live && r.live.length);
    const dvals = []; let pxNull = 0, pxNullLive = 0, over1 = 0, maxD = -1e9, maxDFull = -1e9, staleSnap = 0, snapOver1 = 0, maxSnap = -1e9;
    const pxRows = [];
    for (const r of rows) {
      for (const x of (r.live || [])) {
        dvals.push(x.d);
        if (x.d > maxD) maxD = x.d;
        if (x.d > 1.0 + 1e-9) over1++;
        const cover = (x.len || 0) * (x.tdt || 1 / 60);
        if (cover >= 1.0 && x.d > maxDFull) maxDFull = x.d;
      }
      const projIds = new Set((r.proj || []).map((p) => p.id));
      const liveNull = (r.live || []).filter((x) => x.pxNull && projIds.has(x.id));
      if ((r.live || []).some((x) => x.pxNull)) pxNull++;
      if (liveNull.length) { pxNullLive++; pxRows.push({ f: r.f, t: r.t, ids: liveNull.map((x) => x.id), ds: liveNull.map((x) => x.d), len: liveNull.map((x) => x.len), nProj: (r.proj || []).length }); }
      if (typeof r.age === 'number' && r.age > 0) staleSnap++;
      for (const x of (r.snap || [])) { if (x.d > maxSnap) maxSnap = x.d; if (x.d > 1.0 + 1e-9) snapOver1++; }
    }
    let maxT = 0, liveFrames = 0, frozenFrames = 0, rounds = 1, lastT = null;
    for (const r of rows) { if (typeof r.t === 'number') { if (r.t > maxT) maxT = r.t; if (lastT !== null && r.t < lastT - 0.5) rounds++; lastT = r.t; } if (r.frozen) frozenFrames++; else liveFrames++; }
    let emptyStreak = 0, emptyStreakMax = 0, emptyFrames = 0;
    for (const r of rows) { const np = (r.proj || []).length; if (np === 0) { emptyFrames++; emptyStreak++; if (emptyStreak > emptyStreakMax) emptyStreakMax = emptyStreak; } else emptyStreak = 0; }
    const q = (a, p) => { const b = a.slice().sort((x, y) => x - y); return b.length ? b[Math.min(b.length - 1, Math.max(0, Math.floor(p * b.length)))] : null; };
    const R = (x) => (x === null || x === undefined) ? null : Math.round(x * 1000) / 1000;

    // 四路对齐：每次 TANK_KILLED 前后
    const deathReport = [];
    for (const dd of deaths) {
      let idx = rows.findIndex((r) => Math.abs(r.t - dd.t) < 1e-6);
      if (idx < 0) idx = rows.findIndex((r) => r.t >= dd.t);
      const end = idx < 0 ? rows.length : idx + 1;
      const win = rows.slice(Math.max(0, end - 75), end);
      const hadPred = win.some((r) => r.nodeDead > 0);
      const killAnchorPxNull = win.filter((r) => (r.live || []).some((x) => x.id === dd.pid && x.pxNull)).length;
      const killProjSeen = win.filter((r) => (r.proj || []).some((p) => p.id === dd.pid)).length;
      deathReport.push({ death: dd, atFrame: rows[idx] ? rows[idx].f : null, winFrames: win.length,
        treePredictedDeadFrames: win.filter((r) => r.nodeDead > 0).length, treePredictedDead: hadPred,
        killAnchorPxNullFrames: killAnchorPxNull, killProjAliveFrames: killProjSeen });
    }
    // 假红候选：树有节点说死、但该帧起 75 帧内没有 TANK_KILLED
    let falseRedFrames = 0; const falseRedEx = [];
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (r.nodeDead > 0) {
        const horizon = rows[Math.min(rows.length - 1, i + 75)];
        const died = deaths.some((d) => d.t > r.t - 1e-9 && d.t <= (horizon ? horizon.t : r.t) + 1e-9);
        if (!died) { falseRedFrames++; if (falseRedEx.length < 5) falseRedEx.push({ f: r.f, t: r.t, nodeDead: r.nodeDead, minFd: r.minFd, st: r.st }); }
      }
    }

    const out = { tag: TAG, version: ver, matchModule: MATCHMOD, gameDir: process.env.EV_GAME_DIR || null, frames: FRAMES,
      framesSampled: rows.length, sampledFramesWithThreats: all.length,
      md5Before: fp0, md5After: fp1, md5Stable: JSON.stringify(fp0) === JSON.stringify(fp1),
      delta: { n: dvals.length, min: R(q(dvals, 0)), p50: R(q(dvals, 0.5)), p90: R(q(dvals, 0.9)), p99: R(q(dvals, 0.99)), max: R(maxD),
               over1: over1, maxFullWindow: R(maxDFull), snapMax: R(maxSnap), snapOver1: snapOver1, staleAgeFrames: staleSnap },
      pxNullFrames_any: pxNull, pxNullFrames_liveProj: pxNullLive, pxNullExamples: pxRows.slice(0, 10),
      sampleQuality: { noProjectileFrames: emptyFrames, maxNoProjectileStreak: emptyStreakMax, ctrlMode: CTRL, fire: FIRE, ai: AI_N, vant: VANT_N,
        maxTreeTimeSec: Math.round(maxT * 1000) / 1000, liveFrames, frozenFrames, roundsSeen: rounds },
      deaths: deathReport, deathEventsRaw: deaths,
      falseRedCandidates: { frames: falseRedFrames, examples: falseRedEx,
        note: 'nodeDead>0 是"某个候选节点认为会死"，不等于树的执行路线判断；只作上界' },
      lastRd: rows.length ? rows[rows.length - 1].rd : null,
      tail: rows.slice(-3) };
    fs.writeFileSync(OUT, JSON.stringify({ summary: out, rows }, null, 0));
    console.log('[' + TAG + '] ===== 汇总 =====');
    console.log(JSON.stringify({ version: ver, framesSampled: rows.length, sampleQuality: out.sampleQuality, delta: out.delta, pxNullFrames_any: pxNull, pxNullFrames_liveProj: pxNullLive,
      deaths: deathReport, falseRed: out.falseRedCandidates.frames, md5Stable: out.md5Stable }, null, 1));
    console.log('rows -> ' + OUT);
  } catch (e) {
    err = (e && e.stack) || String(e);
    const fpNow = {}; MD5FILES.forEach((f) => { fpNow[f] = md5(f); });
    console.error('PROBE-FAIL ' + JSON.stringify({ tag: TAG, error: err, md5Before: fp0, md5After: fpNow }));
    process.exitCode = 1;
  } finally { try { await m.close(); } catch (e) {} console.log('[' + TAG + '] done in ' + ((Date.now() - t0) / 1000).toFixed(1) + 's'); }
})();
