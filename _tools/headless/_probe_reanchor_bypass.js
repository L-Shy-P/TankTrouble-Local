'use strict';
/* v169 只读探针（重锚旁路定位）：回答「满窗口型 Δ>1.0 的第二条路径」。
 *
 * 与上一轮 `_dbg_gate2/_dbg_gate4` 的关键差别：
 *   ① Δ 从 **live 树对象**（`VantageTree.getTree().threats`）现算，
 *      Δ = tNow − (rootAbsT + th.anchorOffset)，不依赖 `diag.anchorProbe` 快照 ——
 *      后者在 `runDiagnostics` 早退（tree.threats 为空）时会留在上一帧 ⇒ 探针侧虚高。
 *   ② 同时读 `dumpDiagnostics().reanchorDiag`（v169 产品内只读计数），
 *      逐条出口核对（含 `if (!tracks) return;` 与 hasKids===false 分支）。
 * 场景 = 上一轮出 9.54s 的那一个：1 人操 + 1 Laika + 2 vantage，虚拟时钟。
 * 用法: node _tools/headless/_probe_reanchor_bypass.js --frames=900 [--tag=x] [--maxlist=8]
 */
const { Match } = require('./match');

const SAMPLE = `(() => {
  var out = { ok: false };
  try {
    var d = VantageTree.dumpDiagnostics();
    var t = VantageTree.getTree ? VantageTree.getTree() : null;
    if (!d || !t) return { ok: false, why: 'no-tree' };
    out.ok = true;
    out.t = d.tNow; out.rootAbsT = d.rootAbsT;
    out.frozen = (VantageTree.isFrozen && VantageTree.isFrozen()) ? 1 : 0;
    out.diagFresh = (t.diag && Math.abs(t.diag.lastCheckAt - d.tNow) < 1e-9) ? 1 : 0;
    out.probeAge = (t.diag && typeof t.diag.anchorProbeAt === 'number')
      ? Math.round((d.tNow - t.diag.anchorProbeAt) * 1000) / 1000 : null;
    out.nodes = t.nodeCount;
    out.rebuilds = (t.stats && t.stats.rebuilds) || 0;
    out.commits = (t.stats && t.stats.commits) || 0;
    out.freshRoots = (t.stats && t.stats.freshRoots) || 0;
    // ① live Δ（v169 产品侧导出，直接来自 tree.threats，不经 anchorProbe 快照）
    out.live = (d.liveAnchors || []).map(function (a) {
      return { id: a.id, d: a.delta, off: a.anchorOffset, len: a.trackLen, tdt: a.trackDt,
               noTrack: a.hasTrack ? 0 : 1, hasPath: a.hasPath };
    });
    out.nThreats = out.live.length + ((d.diag && d.diag.threatCount > 0) ? 0 : 0);
    out.treeThreatCount = (d.threats || []).length;
    out.nThreats = out.treeThreatCount;
    out.nLive = (typeof d.liveProjectileCount === 'number') ? d.liveProjectileCount
      : ((t.diag && t.diag.lastProjectileSight) ? t.diag.lastProjectileSight.count : null);
    out.threatIdsEmpty = (d.threats || []).length === 0 ? 1 : 0;
    // ② 探针快照 Δ（旧口径，用于对照）
    out.snap = ((d.diag && d.diag.anchorProbe) || []).map(function (a) {
      return { id: a.id, d: Math.round((d.tNow - a.abs0) * 1000) / 1000, len: a.len };
    });
    // ③ 产品内只读计数
    out.rd = d.reanchorDiag;
    out.anchorProbeAge = d.anchorProbeAge;
    out.ev = (d.events || []).slice(-3).map(function (e) { return (e.type || '?') + ':' + String(e.info || '').slice(0, 24); });
    return out;
  } catch (e) { out.err = String((e && e.message) || e); return out; }
})()`;

(async () => {
  const args = process.argv.slice(2);
  const frames = Number((args.find((a) => a.startsWith('--frames=')) || '').split('=')[1] || 900);
  const tag = (args.find((a) => a.startsWith('--tag=')) || '--tag=?').split('=')[1];
  const maxlist = Number((args.find((a) => a.startsWith('--maxlist=')) || '').split('=')[1] || 8);
  const m = new Match();
  const t0 = Date.now();
  const liveOver = [];        // live Δ>1.0 的帧
  const snapOver = [];        // 快照 Δ>1.0 的帧（旧口径）
  const staleProbe = [];      // anchorProbeAge>0 且 tree.threats 非空的帧
  const artifact = [];        // 快照口径 Δ>1.0 的逐条对照
  const emptyThreatsWithLive = [];
  let last = null, maxLive = 0, maxSnap = 0, nSamples = 0, maxFull = -1e9;
  const topFrames = [];
  try {
    await m.open({ humanIds: ['tank_a'], aiCount: 1, vantCount: 2 });
    const ver = await m.eval('(typeof VantageTree !== "undefined") ? VantageTree.VERSION : "none"');
    for (let f = 0; f < frames; f++) {
      if (f % 40 === 0) {
        const rot = (f / 40) * 0.35;
        await m.eval(`(() => { var gc = GameManager.getGameController(); var a = gc.getTank ? gc.getTank('tank_a') : null;
          if (a && gc.setTankState) gc.setTankState(TankState.withState('tank_a', a.getX(), a.getY(), false,false, ${rot}, false,false,false,false), false);
          window.__vtCtrl.fire = true; return 1; })()`).catch(() => {});
      }
      await m.pump(1);
      const s = await m.eval(SAMPLE).catch(() => null);
      if (!s || !s.ok) continue;
      if (!s.diagFresh) continue;              // 只看本帧真的跑过 runDiagnostics 的样本
      nSamples++;
      last = s;
      let fMax = -1e9, fMaxFull = -1e9;
      for (const x of s.live) {
        if (x.d > maxLive) maxLive = x.d;
        if (x.d > fMax) fMax = x.d;
        const cover = (x.len || 0) * (x.tdt || 0.0167);
        if (cover >= 1.0 && x.d > fMaxFull) fMaxFull = x.d;
        if (x.d > 1.0 + 1e-6) liveOver.push({ t: s.t, id: x.id, d: x.d, off: x.off, len: x.len, noTrack: x.noTrack,
          nThreats: s.nThreats, nLive: s.nLive, frozen: s.frozen, probeAge: s.probeAge, rebuilds: s.rebuilds, ev: s.ev });
      }
      if (fMaxFull > maxFull) maxFull = fMaxFull;
      if (s.live.length) topFrames.push({ f: f, t: s.t, nThreats: s.nThreats, nLive: s.nLive, maxD: fMax, maxDFull: fMaxFull,
        probeAge: s.probeAge, rebuilds: s.rebuilds, frozen: s.frozen, live: s.live });
      for (const x of s.snap) {
        if (x.d > maxSnap) maxSnap = x.d;
        if (x.d > 1.0 + 1e-6) snapOver.push({ t: s.t, id: x.id, d: x.d, len: x.len });
      }
      if (typeof s.probeAge === 'number' && s.probeAge > 0 && s.nThreats > 0) {
        staleProbe.push({ t: s.t, age: s.probeAge, nThreats: s.nThreats, nLive: s.nLive });
      }
      if (s.threatIdsEmpty && s.nLive > 0) {
        emptyThreatsWithLive.push({ t: s.t, nLive: s.nLive, rebuilds: s.rebuilds, frozen: s.frozen, probeAge: s.probeAge });
      }
      // 对照：快照口径 Δ>1.0 是否只是「anchorProbe 陈旧 = probeAge」造成的虚高
      const liveMax = s.live.length ? Math.max.apply(null, s.live.map((x) => x.d)) : null;
      for (const x of s.snap) {
        if (x.d <= 1.0 + 1e-6) continue;
        const infl = (typeof s.probeAge === 'number') ? s.probeAge : null;
        artifact.push({ t: s.t, snapD: x.d, liveMax: liveMax, probeAge: infl, emptyThreats: s.threatIdsEmpty,
          nLive: s.nLive, diff: (liveMax === null || infl === null) ? null : Math.round((x.d - liveMax) * 1000) / 1000 });
      }
    }
    await m.clearControl();
    const rd = last ? last.rd : null;
    console.log('=== [' + tag + '] VantageTree.VERSION=' + ver + ' frames=' + frames + ' samples=' + nSamples + ' ===');
    console.log('LIVE Δ: max=' + maxLive.toFixed(3) + 's  >1.0 的(弹×帧)=' + liveOver.length +
      ' ；快照口径(旧) Δ max=' + maxSnap.toFixed(3) + ' >1.0=' + snapOver.length +
      ' ；满窗口型(cover>=1s) LIVE Δ max=' + (maxFull === -1e9 ? '-' : maxFull.toFixed(3)));
    topFrames.sort((a, b) => b.maxD - a.maxD);
    console.log('  最大 liveΔ 的 5 帧: ' + JSON.stringify(topFrames.slice(0, 5)));
    if (liveOver.length) {
      console.log('  LIVE Δ>1.0 明细(前' + maxlist + '): ' + JSON.stringify(liveOver.slice(0, maxlist)));
    }
    if (snapOver.length && !liveOver.length) {
      console.log('  ⚠️ 快照口径有 Δ>1.0 而 live 没有 ⇒ 旧口径是【探针快照陈旧】造成的虚高；样例=' +
        JSON.stringify(snapOver.slice(0, 3)));
    }
    console.log('anchorProbe 陈旧帧(probeAge>0 且树里有弹)=' + staleProbe.length +
      (staleProbe.length ? ' 样例=' + JSON.stringify(staleProbe.slice(0, 3)) : ''));
    console.log('tree.threats 为空但真实有弹的帧=' + emptyThreatsWithLive.length +
      (emptyThreatsWithLive.length ? ' 样例=' + JSON.stringify(emptyThreatsWithLive.slice(0, 4)) : ''));
    if (artifact.length) {
      const worst = artifact.slice().sort((a, b) => b.snapD - a.snapD).slice(0, 5);
      const exact = artifact.filter((a) => a.diff !== null && Math.abs(a.diff) < 0.05).length;
      console.log('快照口径 Δ>1.0 共 ' + artifact.length + ' 条；其中 |snapΔ − liveΔ − probeAge| < 0.05 的=' +
        artifact.filter((a) => a.liveMax !== null && a.probeAge !== null &&
          Math.abs((a.snapD - a.liveMax) - a.probeAge) < 0.05).length +
        '；liveΔ 也是 >1.0 的=' + artifact.filter((a) => a.liveMax !== null && a.liveMax > 1.0).length +
        '；快照时 tree.threats 为空的=' + artifact.filter((a) => a.emptyThreats).length);
      console.log('  最坏 5 条[snapΔ, liveΔ, probeAge, emptyThreats]=' +
        JSON.stringify(worst.map((a) => [a.snapD, a.liveMax, a.probeAge, a.emptyThreats])));
    }
    if (rd) {
      console.log('reanchorDiag.ensureCalls=' + rd.ensureCalls + ' byCaller=' + JSON.stringify(rd.ensureByCaller));
      console.log('  早退出口=' + JSON.stringify(rd.ensureEarlyReturn));
      console.log('  逐弹门=' + JSON.stringify(rd.perThreat));
      console.log('  路径审计=' + JSON.stringify(rd.paths));
      console.log('  Δ>1.0 现场=' + JSON.stringify(rd.over1Examples));
      console.log('  anchorProbe 计数=' + JSON.stringify(rd.probe));
      console.log('  统计: commits=' + last.commits + ' rebuilds=' + last.rebuilds + ' freshRoots=' + last.freshRoots +
        ' nodes=' + last.nodes);
    }
    console.log('wallMs=' + (Date.now() - t0));
  } catch (e) { console.error('FAILED:', (e && e.stack) || e); process.exitCode = 1; }
  finally { await m.close(); }
})();
