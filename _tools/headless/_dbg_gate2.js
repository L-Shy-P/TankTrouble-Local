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

function pct(a, p) { a = a.slice().sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.max(0, Math.floor(p * a.length)))]; }

(async () => {
  const frames = Number((process.argv.find((a) => a.startsWith('--frames=')) || '').split('=')[1] || 900);
  const tag = (process.argv.find((a) => a.startsWith('--tag=')) || '--tag=?').split('=')[1];
  const m = new Match();
  const t0 = Date.now();
  try {
    await m.open({ humanIds: ['tank_a'], aiCount: 1, vantCount: 2 });
    const ver = await m.eval('(typeof VantageTree !== "undefined") ? VantageTree.VERSION : "none"');
    await m.eval(PAGE_SRC);
    const rows = [];
    const commits = [];
    let prevFresh = null;
    const gate = { reuse: 0, resim: 0, violate: 0, violEx: [], reuseDelta: [], resimLen: [] };
    for (let f = 0; f < frames; f++) {
      if (f % 40 === 0) {
        const rot = (f / 40) * 0.35;
        await m.eval(`(() => { var gc = GameManager.getGameController(); var a = gc.getTank ? gc.getTank('tank_a') : null;
          if (a && gc.setTankState) gc.setTankState(TankState.withState('tank_a', a.getX(), a.getY(), false,false, ${rot}, false,false,false,false), false);
          window.__vtCtrl.fire = true; return 1; })()`);
      }
      await m.pump(1);
      const s = await m.eval('window.__rf.sample()').catch(() => null);
      if (!s || !s.ok) continue;
      for (const a of s.anchors) {
        rows.push({ t: s.t, id: a.id, d: a.d, cover: a.cover, len: a.len, tdt: a.tdt, need: s.needFrames,
                    pxNull: a.pxNull, err: a.err, blind: a.blind, n: a.n, horizon: s.horizon,
                    frozen: s.frozen, fresh: s.diagFresh, abs0: a.abs0 });
      }
      if (s.diagFresh) {
        if (prevFresh && Math.abs(s.rootAbsT - prevFresh.rootAbsT) > 1e-6) {
          const shift = s.rootAbsT - prevFresh.rootAbsT;
          commits.push({ t: s.t, shift: shift });
          const pm = {}; for (const a of prevFresh.anchors) pm[a.id] = a;
          for (const a of s.anchors) {
            const p = pm[a.id];
            if (!p) continue;
            const reused = Math.abs(a.abs0 - p.abs0) < 1e-6;
            const dAfter = s.t - a.abs0;
            if (reused) {
              gate.reuse++; gate.reuseDelta.push(dAfter);
              if (dAfter > 1.0 + 1e-6) { gate.violate++; if (gate.violEx.length < 5) gate.violEx.push({ t: s.t, id: a.id, dAfter: dAfter, shift: shift, len: a.len, need: s.needFrames }); }
            } else { gate.resim++; gate.resimLen.push(a.len); }
          }
        }
        prevFresh = s;
      }
    }
    await m.clearControl();

    const fresh = rows.filter((r) => r.fresh);
    const D = fresh.map((r) => r.d);
    console.log('=== 门行为分析 [' + tag + '] 页面里的 VantageTree.VERSION=' + ver + ' ===');
    if (!fresh.length) { console.log('无有效样本'); }
    else {
      console.log('有效样本=' + fresh.length + '/' + rows.length + ' 覆盖max=' + Math.max(...fresh.map((r) => r.cover)).toFixed(2) +
        's horizon max=' + Math.max(...fresh.map((r) => r.horizon)).toFixed(2) + 's');
      console.log('Delta: min=' + pct(D, 0).toFixed(3) + ' med=' + pct(D, .5).toFixed(3) + ' p90=' + pct(D, .9).toFixed(3) +
        ' p99=' + pct(D, .99).toFixed(3) + ' max=' + pct(D, 1).toFixed(3));
      const over = fresh.filter((r) => r.d > 1.0);
      console.log('Delta>1.0 样本=' + over.length + '/' + fresh.length + ' = ' + (100 * over.length / fresh.length).toFixed(1) + '%');
      if (over.length) console.log('  Delta>1.0 里：覆盖<1.0s 的（轨迹本身被寿命截断）=' + over.filter((r) => r.cover < 1.0).length +
        '；Δ>覆盖 的=' + over.filter((r) => r.d > r.cover).length + '；取位 null=' + over.filter((r) => r.pxNull).length);
      console.log('Delta>覆盖 样本=' + fresh.filter((r) => r.d > r.cover).length + '；取位 null=' + fresh.filter((r) => r.pxNull).length);
      console.log('小覆盖样本（cover<1s，寿命截断型）=' + fresh.filter((r) => r.cover < 1.0).length + '/' + fresh.length);
      const big = fresh.filter((r) => r.cover >= 1.0);
      console.log('只看满窗口型(cover>=1s)：n=' + big.length + ' Delta max=' + (big.length ? Math.max(...big.map((r) => r.d)).toFixed(3) : '-') +
        ' med=' + (big.length ? pct(big.map((r) => r.d), .5).toFixed(3) : '-') + ' 取位null=' + big.filter((r) => r.pxNull).length);
    }
    console.log('commit=' + commits.length + ' shift med=' + (commits.length ? pct(commits.map((c) => c.shift), .5).toFixed(3) : '-') +
      ' max=' + (commits.length ? pct(commits.map((c) => c.shift), 1).toFixed(3) : '-'));
    console.log('门判定（逐 commit-威胁）：复用=' + gate.reuse + ' 重模拟=' + gate.resim + ' 【违例：复用后 Δ>1.0】=' + gate.violate);
    if (gate.violEx.length) console.log('  违例样例: ' + JSON.stringify(gate.violEx));
    if (gate.reuseDelta.length) console.log('  复用后 Δ 分布: med=' + pct(gate.reuseDelta, .5).toFixed(3) + ' p90=' + pct(gate.reuseDelta, .9).toFixed(3) + ' max=' + pct(gate.reuseDelta, 1).toFixed(3));
    if (gate.resimLen.length) console.log('  重模拟后 track 长度: min=' + Math.min(...gate.resimLen) + ' med=' + pct(gate.resimLen, .5) + ' max=' + Math.max(...gate.resimLen));
    console.log('wallMs=' + (Date.now() - t0));
  } catch (e) { console.error('FAILED:', (e && e.stack) || e); process.exitCode = 1; }
  finally { await m.close(); }
})();
