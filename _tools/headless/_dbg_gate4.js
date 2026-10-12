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
    await m.open({ humanIds: ['tank_a'], aiCount: 1, vantCount: 2 });
    await m.eval(`(() => {
      window.__w = { n: 0, msgs: [] };
      var ow = console.warn;
      console.warn = function () { var s = Array.prototype.join.call(arguments, ' '); window.__w.n++; if (window.__w.msgs.length < 6) window.__w.msgs.push(String(s).slice(0, 120)); ow.apply(console, arguments); };
      return 1; })()`);
    const rows = [];
    for (let f = 0; f < frames; f++) {
      if (f % 40 === 0) await m.eval(`(() => { var gc = GameManager.getGameController(); var a = gc.getTank('tank_a');
        if (a && gc.setTankState) gc.setTankState(TankState.withState('tank_a', a.getX(), a.getY(), false,false, ${f/40*0.35}, false,false,false,false), false);
        window.__vtCtrl.fire = true; return 1; })()`).catch(()=>{});
      await m.pump(1);
      const s = await m.eval(`(() => {
        var d = VantageTree.dumpDiagnostics(); var t = VantageTree.getTree();
        return { t: d.tNow, root: d.rootAbsT, fresh: (t.diag && Math.abs(t.diag.lastCheckAt - d.tNow) < 1e-9) ? 1 : 0,
          rebuilds: (t.stats && t.stats.rebuilds) || 0, warns: window.__w.n,
          ev: (d.events || []).slice(-2).map(function (e) { return (e.kind || '') + ':' + String(e.msg || '').slice(0, 30); }),
          anchors: ((d.diag && d.diag.anchorProbe) || []).map(function (a) { return { id: a.id, d: d.tNow - a.abs0, cover: (a.len || 0) * (a.tdt || 0.02), len: a.len }; }) };
      })()`).catch(() => null);
      if (s && s.fresh) rows.push(s);
    }
    await m.clearControl();
    let nCommit = 0; const cases = [];
    for (let k = 1; k < rows.length; k++) {
      const a = rows[k - 1], b = rows[k];
      if (Math.abs(b.root - a.root) < 1e-6) continue;
      nCommit++;
      const pm = {}; for (const x of a.anchors) pm[x.id] = x;
      for (const x of b.anchors) {
        const p = pm[x.id]; if (!p) continue;
        const reused = Math.abs((x.d - p.d) - (b.t - a.t)) < 0.005;
        if (reused && x.d > 1.05) cases.push({ t: +b.t.toFixed(2), dt: +(b.t - a.t).toFixed(3), id: x.id, d: +x.d.toFixed(3), len: x.len, cover: +x.cover.toFixed(2), rebuilds: b.rebuilds, dReb: b.rebuilds - a.rebuilds, warns: b.warns - a.warns, ev: b.ev });
      }
    }
    console.log('commit=' + nCommit + ' 违例(复用且 Δ>1.05)=' + cases.length);
    console.log('样例=' + JSON.stringify(cases.slice(-4)));
    const all = []; for (const r of rows) for (const x of r.anchors) all.push(x.d); all.sort((p, q) => p - q);
    console.log('Δ med=' + (all.length ? all[Math.floor(all.length/2)].toFixed(3) : '-') + ' max=' + (all.length ? all[all.length-1].toFixed(3) : '-') + ' n=' + all.length);
    console.log('console.warn 总数=' + (rows.length ? rows[rows.length-1].warns : '?') + ' msgs=' + JSON.stringify(await m.eval('window.__w.msgs')));
    console.log('rebuilds 总=' + (rows.length ? rows[rows.length-1].rebuilds : '?'));
  } catch (e) { console.error('FAILED:', (e && e.stack) || e); process.exitCode = 1; }
  finally { await m.close(); }
})();
