'use strict';
/* 只读探针（第二版）：核实 reanchorThreatsAtCommit 的复用门
 *   if (old && old.track && old.track.length >= needFrames && shift <= 1.0)
 * 关键：tree.diag.anchorProbe 在 tick 里【先于 commit】刷新（runDiagnostics:7480 < commit:~7620），
 *       所以 commit 帧读到的 anchor 是 commit 前的。⇒ 判定要在 k-1 与 k+1 之间比。
 * 不改 game_core。用法: node _tools/headless/_probe_reanchor_gate.js --frames=700
 */
const { Match } = require('./match');

const SRC = `(() => {
  if (window.__rgProbe) return 'exists';
  window.__rgProbe = function () {
    var out = { ok: false };
    try {
      var d = VantageTree.dumpDiagnostics();
      var t = VantageTree.getTree ? VantageTree.getTree() : null;
      out.ok = true;
      out.t = d.tNow; out.rootAbsT = d.rootAbsT;
      out.needFrames = (t && t.diag && typeof t.diag.trackFrames === 'number') ? t.diag.trackFrames : null;
      out.horizon = (t && t.cfg) ? t.cfg.horizonSec : null;
      out.frameDt = (typeof d.frameDt === 'number') ? d.frameDt : null;
      out.anchors = (d.diag && d.diag.anchorProbe) ? d.diag.anchorProbe.map(function (a) {
        return { id: a.id, abs0: a.abs0, len: a.len, v0: a.v0, vr: a.vr, drift: a.drift };
      }) : [];
      out.threatIds = (d.threats || []).map(function (x) { return x && x.id; });
    } catch (e) { out.err = String((e && e.message) || e); }
    return out;
  };
  return 'ok';
})()`;

function pct(a, p) { a = a.slice().sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.max(0, Math.floor(p * a.length)))]; }

(async () => {
  const frames = Number((process.argv.find((a) => a.startsWith('--frames=')) || '').split('=')[1] || 700);
  const m = new Match();
  const samples = [];
  let framesSeen = 0;
  try {
    await m.open({ humanIds: ['tank_a'], aiCount: 1, vantCount: 2 });
    await m.eval(SRC);
    for (let f = 0; f < frames; f++) {
      if (f % 40 === 0) {
        const rot = (f / 40) * 0.35;
        await m.eval(`(() => { var gc = GameManager.getGameController(); var a = gc.getTank('tank_a');
          if (a && gc.setTankState) gc.setTankState(TankState.withState('tank_a', a.getX(), a.getY(), false,false, ${rot}, false,false,false,false), false);
          window.__vtCtrl.fire = true; return 1; })()`);
      }
      await m.pump(1); framesSeen++;
      const s = await m.eval('window.__rgProbe()').catch(() => null);
      samples.push(s && s.ok ? s : null);
    }
    await m.clearControl();
    const ok = samples.filter(Boolean);
    // ---- Δ（用"帧自身 t 与 anchorProbe 的 abs0"；commit 帧的 abs0 是 commit 前的，
    //      但对【复用】威胁 abs0 本来就不随 commit 变 ⇒ 无偏差；对【重模拟】威胁
    //      该帧会少一次跳变（下一帧才看到），只影响 commit 那一帧）
    const deltas = [];
    for (const s of ok) for (const a of (s.anchors || [])) if (a && typeof a.abs0 === 'number') deltas.push(s.t - a.abs0);
    // ---- commit：rootAbsT 变化
    const commits = [];
    for (let k = 1; k < ok.length; k++) {
      if (Math.abs(ok[k].rootAbsT - ok[k - 1].rootAbsT) > 1e-6) commits.push(k);
    }
    const rows = [];
    for (const k of commits) {
      const a = ok[k - 1], c = ok[k + 1] || ok[k];   // 跳过 commit 帧本身
      const prev = {}, cur = {};
      for (const x of (a.anchors || [])) prev[x.id] = x;
      for (const x of (c.anchors || [])) cur[x.id] = x;
      const shift = ok[k].rootAbsT - ok[k - 1].rootAbsT;
      const newRoot = ok[k].rootAbsT;
      for (const id in cur) {
        const q = cur[id], p = prev[id];
        const tol = 2 * Math.max(0.0167, (ok[k + 1] ? (ok[k + 1].t - ok[k].t) : 0.02)) + 1e-6;
        if (!p) { rows.push({ k: k, t: ok[k].t, id: id, kind: 'new', lb: null, la: q.len, shift: shift, need: c.needFrames, abs0new: q.abs0, newRoot: newRoot }); continue; }
        const reused = Math.abs(q.abs0 - p.abs0) < tol;
        rows.push({ k: k, t: ok[k].t, id: id, kind: reused ? 'reuse' : 'resim', lb: p.len, la: q.len,
          shift: Math.round(shift * 1000) / 1000, need: c.needFrames, needAt: a.needFrames,
          abs0new: q.abs0, newRoot: newRoot, dab: Math.round((q.abs0 - p.abs0) * 1000) / 1000 });
      }
    }
    console.log('=== 锚点复用门探针 v2（当前 build）===');
    console.log('帧=' + framesSeen + ' 有效样本=' + ok.length + ' horizonSec=' + (ok[ok.length - 1] || {}).horizon + ' frameDt=' + (ok[ok.length - 1] || {}).frameDt);
    console.log('Δ 分布: n=' + deltas.length + ' min=' + pct(deltas, 0).toFixed(3) + ' med=' + pct(deltas, .5).toFixed(3) +
      ' p90=' + pct(deltas, .9).toFixed(3) + ' p99=' + pct(deltas, .99).toFixed(3) + ' max=' + pct(deltas, 1).toFixed(3));
    console.log('commit=' + commits.length + '  shift: med=' + pct(commits.map((k) => ok[k].rootAbsT - ok[k - 1].rootAbsT), .5).toFixed(3) +
      ' p90=' + pct(commits.map((k) => ok[k].rootAbsT - ok[k - 1].rootAbsT), .9).toFixed(3) +
      ' max=' + pct(commits.map((k) => ok[k].rootAbsT - ok[k - 1].rootAbsT), 1).toFixed(3));
    console.log('needFrames 观测值=' + JSON.stringify(Array.from(new Set(ok.map((s) => s.needFrames))).slice(0, 6)));
    const re = rows.filter((r) => r.kind === 'reuse'), rs = rows.filter((r) => r.kind === 'resim'), nw = rows.filter((r) => r.kind === 'new');
    console.log('决策: reuse=' + re.length + ' resim=' + rs.length + ' new=' + nw.length + ' 总威胁-commit=' + rows.length);
    const tag = (r) => r.lb + '→' + r.la + '@need' + r.need + '/lb' + r.lb;
    console.log('  reuse 例: ' + JSON.stringify(re.slice(0, 8).map((r) => ({ id: r.id, t: r.t, s: r.shift, need: r.need, lb: r.lb, la: r.la }))));
    console.log('  resim 例: ' + JSON.stringify(rs.slice(0, 8).map((r) => ({ id: r.id, t: r.t, s: r.shift, need: r.need, lb: r.lb, la: r.la }))));
    const gateHolds = (r) => (r.lb >= r.need && r.shift <= 1.0);
    console.log('  门限自检（用 lb 与 commit 后的 needFrames）: reuse 且门成立=' + re.filter(gateHolds).length + '/' + re.length +
      '  resim 且门不成立=' + rs.filter((r) => !gateHolds(r)).length + '/' + rs.length);
    console.log('  resim 且门【成立】的行（应=0，否则说明还有别的重锚路径）=' +
      JSON.stringify(rs.filter(gateHolds).slice(0, 6).map((r) => ({ id: r.id, t: r.t, s: r.shift, need: r.need, lb: r.lb, la: r.la, dab: r.dab }))));
    console.log('  reuse 且 lb<need 的行（应=0）=' +
      JSON.stringify(re.filter((r) => r.lb < r.need).slice(0, 6).map((r) => ({ id: r.id, t: r.t, s: r.shift, need: r.need, lb: r.lb, la: r.la, dab: r.dab }))));
    console.log('  shift>1.0 的 commit 数=' + commits.filter((k) => (ok[k].rootAbsT - ok[k - 1].rootAbsT) > 1.0).length);
    const byId = {};
    for (const r of rows) { const o = byId[r.id] = byId[r.id] || { reuse: 0, resim: 0, lmin: 1e9, lmax: 0 }; o[r.kind]++; if (r.la) { o.lmin = Math.min(o.lmin, r.la); o.lmax = Math.max(o.lmax, r.la); } }
    console.log('  逐威胁决策: ' + JSON.stringify(byId));
  } catch (e) {
    console.error('FAILED:', (e && e.stack) || e);
    process.exitCode = 1;
  } finally { await m.close(); }
})();
