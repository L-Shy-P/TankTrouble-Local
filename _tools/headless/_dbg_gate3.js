'use strict';
/* 只读探针（重锚门修正用）：证明「锚点长期复用 -> 取位越界失效」+ 量化复用/重模拟频率。
 * 不改 game_core，只读 VantageTree 的公开导出（dumpDiagnostics / getTree / _coarse.setNow）。
 * P1 逐帧：每颗被锚定活弹 -> Delta=t-abs0、覆盖=len*tdt、px(trackPosAt 的"现在"取位)、真实弹位 rx/ry、
 *          以及"深节点盲区"节点数（节点 n 满足 (n.tEndSec-tNow)+Delta > 覆盖 => 该节点查询越过轨迹末端 -> null）。
 * P2 受控时移：用 _coarse.setNow 把"现在"推后 X 秒（查询 q=X），跑一帧让 runDiagnostics 重算 px。
 * 用法: node _tools/headless/_probe_reanchor_fix.js --frames=900 [--tag=before]
 */
const { Match } = require('./match');

const PAGE_SRC = `(() => {
  if (window.__rf) return 'exists';
  window.__rf = {};
  window.__rf.sample = function () {
    var out = { ok: false };
    try {
      var d = VantageTree.dumpDiagnostics();
      var t = VantageTree.getTree ? VantageTree.getTree() : null;
      if (!d || !t) return { ok: false, why: 'no-tree' };
      out.ok = true;
      out.t = d.tNow; out.rootAbsT = d.rootAbsT;
      out.frozen = (VantageTree.isFrozen && VantageTree.isFrozen()) ? 1 : 0;
      out.diagFresh = (t.diag && Math.abs(t.diag.lastCheckAt - d.tNow) < 1e-9) ? 1 : 0;
      out.horizon = t.horizonSec;
      out.nodes = t.nodeCount;
      out.needFrames = (t.diag && typeof t.diag.trackFrames === 'number') ? t.diag.trackFrames : null;
      out.fusedDrop = (typeof t._fusedDropFrame === 'number') ? t._fusedDropFrame : null;
      out.desyncs = (t.diag.bulletDesyncs || []).length;
      out.missing = (t.diag.missingBullets || []).length;
      var ends = [];
      try { t.walk(function (n) { if (n && n !== t.root && typeof n.tEndSec === 'number') ends.push(n.tEndSec); }); } catch (e2) {}
      out.nNode = ends.length;
      out.anchors = ((d.diag && d.diag.anchorProbe) || []).map(function (a) {
        var delta = out.t - a.abs0;
        var cover = (a.len || 0) * (a.tdt || 0.02);
        var blind = 0;
        for (var i = 0; i < ends.length; i++) { if ((ends[i] - out.t) + delta > cover) blind++; }
        var pxNull = (a.px === null || a.px === undefined);
        var err = null;
        if (!pxNull && a.rx !== null && a.rx !== undefined) {
          var dx = a.px - a.rx, dy = a.py - a.ry;
          err = Math.sqrt(dx * dx + dy * dy);
        }
        return { id: a.id, d: Math.round(delta * 1000) / 1000, cover: Math.round(cover * 100) / 100,
                 len: a.len, tdt: a.tdt, pxNull: pxNull, err: err, blind: blind, n: ends.length,
                 px: a.px, py: a.py, rx: a.rx, ry: a.ry, abs0: a.abs0 };
      });
      return out;
    } catch (e) { out.err = String((e && e.message) || e); return out; }
  };
  return 'ok';
})()`;

(async () => {
  const frames = Number((process.argv.find((a) => a.startsWith('--frames=')) || '').split('=')[1] || 700);
  const m = new Match();
  try {
    await m.open({ humanIds: ['tank_a'], aiCount: 1, vantCount: 1 });
    const armed = await m.eval(`(() => {
      if (!window.__g3) window.__g3 = {};
      var mgr = null, ids = [];
      for (var i = 0; i < AIs.aiManagers.length; i++) { ids.push(AIs.aiManagers[i].aiId); if (String(AIs.aiManagers[i].aiId).indexOf('vantage') === 0) mgr = AIs.aiManagers[i]; }
      if (!mgr) return { err: 'no-vantage-manager', ids: ids };
      var ai = mgr.ai; window.__g3ai = ai;
      var ad = ai && ai._vantageAdapter;
      if (!ad) return { err: 'no-adapter', ids: ids, aiKeys: ai ? Object.keys(ai).slice(0, 25) : null };
      if (!ad.simulateBulletTracks) return { err: 'no-sim' };
      if (ad.__g3) return { ok: true, already: true };
      var orig = ad.simulateBulletTracks;
      window.__g3calls = []; window.__g3t = 0;
      ad.simulateBulletTracks = function (nf, only) {
        var out = null;
        try { out = orig.apply(ad, arguments); } catch (e) { window.__g3err = String(e && e.message || e); throw e; }
        var lens = [];
        for (var i = 0; i < (out || []).length && i < 6; i++) lens.push((out[i] && out[i].id) + ':' + (((out[i] || {}).frames || []).length));
        window.__g3calls.push({ nf: nf, only: only ? only.length : null, ids: only ? only.slice(0, 4) : null, got: (out || []).length, lens: lens });
        if (window.__g3calls.length > 600) window.__g3calls.shift();
        return out;
      };
      ad.__g3 = true;
      return { ok: true, version: VantageTree.VERSION };
    })()`);
    console.log('arm=' + JSON.stringify(armed));
    const rows = [];
    let prev = null;
    for (let f = 0; f < frames; f++) {
      if (f % 30 === 0) await m.eval(`(() => { var gc = GameManager.getGameController(); var a = gc.getTank('tank_a');
        if (a && gc.setTankState) gc.setTankState(TankState.withState('tank_a', a.getX(), a.getY(), false,false, ${f/30*0.3}, false,false,true,false), false);
        window.__vtCtrl.fire = true; return 1; })()`).catch(()=>{});
      await m.pump(1);
      const s = await m.eval(`(() => {
        var d = VantageTree.dumpDiagnostics(); var t = VantageTree.getTree();
        var calls = window.__g3calls || []; window.__g3calls = [];
        var out = { t: d.tNow, root: d.rootAbsT, fresh: (t.diag && Math.abs(t.diag.lastCheckAt - d.tNow) < 1e-9) ? 1 : 0,
          calls: calls, nodes: t.nodeCount,
          anchors: ((d.diag && d.diag.anchorProbe) || []).map(function (a) {
            return { id: a.id, d: d.tNow - a.abs0, cover: (a.len || 0) * (a.tdt || 0.02), len: a.len, px: (a.px === null ? null : 1) }; }) };
        return out; })()`).catch(() => null);
      if (!s || !s.fresh) continue;
      rows.push(s);
      prev = s;
    }
    await m.clearControl();
    // 分析：commit 帧上，Δ_after 是否越界；那一帧有没有 simulateBulletTracks 调用
    let nCommit = 0, nViol = 0, nViolWithSim = 0, nViolNoSim = 0, nSimOnCommit = 0, nSimTotal = 0;
    const ex = [];
    for (let k = 1; k < rows.length; k++) {
      const a = rows[k - 1], b = rows[k];
      nSimTotal += b.calls.length;
      if (Math.abs(b.root - a.root) < 1e-6) continue;
      nCommit++;
      if (b.calls.length) nSimOnCommit++;
      const pm = {}; for (const x of a.anchors) pm[x.id] = x;
      for (const x of b.anchors) {
        const p = pm[x.id]; if (!p) continue;
        const reused = Math.abs((x.d - p.d) - (b.t - a.t)) < 0.005;   // Δ 增长 = 时间差 ⇒ 锚点没被重置
        if (reused && x.d > 1.05) {
          nViol++;
          if (b.calls.length) nViolWithSim++; else nViolNoSim++;
          if (ex.length < 4) ex.push({ t: +b.t.toFixed(2), id: x.id, d: +x.d.toFixed(3), len: x.len, cover: +x.cover.toFixed(2), simCalls: b.calls.length, simIds: b.calls.map((c) => c.ids).slice(0, 2) });
        }
      }
    }
    console.log('commit=' + nCommit + ' 其中带 simulateBulletTracks 调用的=' + nSimOnCommit + ' 总 sim 调用=' + nSimTotal);
    console.log('复用后 Δ>1.05 的 commit-威胁数=' + nViol + '（该帧有 sim 调用=' + nViolWithSim + '，无 sim 调用=' + nViolNoSim + '）');
    console.log('样例=' + JSON.stringify(ex));
    const all = []; for (const r of rows) for (const x of r.anchors) all.push(x.d);
    all.sort((p, q) => p - q);
    console.log('Δ max=' + (all.length ? all[all.length - 1].toFixed(3) : '-') + ' n=' + all.length);
    const err = await m.eval('window.__g3err || null');
    if (err) console.log('sim 抛错=' + err);
  } catch (e) { console.error('FAILED:', (e && e.stack) || e); process.exitCode = 1; }
  finally { await m.close(); }
})();
