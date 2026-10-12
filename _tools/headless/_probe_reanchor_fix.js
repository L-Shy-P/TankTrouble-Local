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
    await m.eval(PAGE_SRC);
    const rows = [];
    const resim = [];
    const commits = [];
    const lastSeen = {};
    let last = null;
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
      if (last && Math.abs(s.rootAbsT - last.rootAbsT) > 1e-6) commits.push(s.rootAbsT - last.rootAbsT);
      for (const a of s.anchors) {
        rows.push({ t: s.t, id: a.id, d: a.d, cover: a.cover, len: a.len, tdt: a.tdt, need: s.needFrames,
                    pxNull: a.pxNull, err: a.err, blind: a.blind, n: a.n, horizon: s.horizon,
                    frozen: s.frozen, fresh: s.diagFresh });
        const p = lastSeen[a.id];
        if (p && a.abs0 - p.abs0 > 0.02) resim.push({ t: s.t, id: a.id, back: a.abs0 - p.abs0, dBefore: p.d, len: a.len });
        lastSeen[a.id] = { t: s.t, abs0: a.abs0, len: a.len, d: a.d };
      }
      last = s;
    }
    await m.clearControl();

    const freshRows = rows.filter((r) => r.fresh);
    const D = freshRows.map((r) => r.d);
    const cover = freshRows.length ? Math.max(...freshRows.map((r) => r.cover)) : 0;
    const nullRows = freshRows.filter((r) => r.pxNull);
    const errs = freshRows.filter((r) => r.err !== null).map((r) => r.err);
    const blindRows = freshRows.filter((r) => r.blind > 0);
    console.log('=== 重锚门探针 rf [' + tag + '] ===');
    console.log('帧=' + frames + ' 威胁-帧样本=' + rows.length + ' 有效(diag本帧刷新)=' + freshRows.length +
      ' 冻结帧=' + rows.filter((r) => r.frozen).length +
      ' 覆盖(最大观测)=' + cover.toFixed(2) + 's horizon(最深节点)=' + (freshRows.length ? Math.max(...freshRows.map((r) => r.horizon)).toFixed(2) : '-') + 's 节点数=' + (last ? last.nNode : '-'));
    if (!freshRows.length) { console.log('本跑没有有效样本（树一直冻结）'); }
    else {
      console.log('Delta: n=' + D.length + ' min=' + pct(D, 0).toFixed(3) + ' med=' + pct(D, .5).toFixed(3) +
        ' p90=' + pct(D, .9).toFixed(3) + ' p99=' + pct(D, .99).toFixed(3) + ' max=' + pct(D, 1).toFixed(3));
      console.log('Delta>1.0 的样本=' + freshRows.filter((r) => r.d > 1.0).length + '/' + freshRows.length +
        '  Delta>覆盖=' + freshRows.filter((r) => r.d > r.cover).length +
        '  实测取位 null=' + nullRows.length);
      console.log('门条件①(len>=needFrames)=' + freshRows.filter((r) => r.need && r.len >= r.need).length + '/' + freshRows.length);
      console.log('取位非空样本位置误差: n=' + errs.length + ' med=' + (errs.length ? pct(errs, .5).toFixed(3) : '-') +
        ' p90=' + (errs.length ? pct(errs, .9).toFixed(3) : '-') + ' max=' + (errs.length ? pct(errs, 1).toFixed(3) : '-') + ' m');
      console.log('深节点盲区样本=' + blindRows.length + '/' + freshRows.length +
        ' = ' + (100 * blindRows.length / freshRows.length).toFixed(1) + '%；平均盲区节点数=' +
        (blindRows.length ? (blindRows.reduce((s, r) => s + r.blind, 0) / blindRows.length).toFixed(1) : 0));
      const byId = {};
      for (const r of freshRows) { const o = byId[r.id] = byId[r.id] || { n: 0, dmax: 0, nullN: 0, errMax: 0, t0: 1e9, t1: 0, cover: 0, resims: 0, blind: 0 }; o.n++; o.t0 = Math.min(o.t0, r.t); o.t1 = Math.max(o.t1, r.t); o.dmax = Math.max(o.dmax, r.d); o.cover = Math.max(o.cover, r.cover); if (r.pxNull) o.nullN++; if (r.err) o.errMax = Math.max(o.errMax, r.err); if (r.blind > 0) o.blind++; }
      for (const r of resim) if (byId[r.id]) byId[r.id].resims++;
      console.log('逐威胁（DeltaMax / 覆盖 / 取位null / 最大位置误差 / 重模拟次数 / 盲区样本）：');
      for (const id of Object.keys(byId).sort((a, b) => byId[b].dmax - byId[a].dmax).slice(0, 6)) {
        const o = byId[id];
        console.log('   ' + id.padEnd(14) + ' n=' + String(o.n).padStart(4) + ' 存活=' + (o.t1 - o.t0).toFixed(2) + 's Dmax=' + o.dmax.toFixed(3) +
          ' 覆盖=' + o.cover.toFixed(2) + ' D/覆盖=' + (o.cover ? (o.dmax / o.cover).toFixed(2) : '-') +
          ' 取位null=' + o.nullN + ' errMax=' + o.errMax.toFixed(2) + 'm 重模拟=' + o.resims + ' 盲区样本=' + o.blind);
      }
      const ids = Object.keys(byId).sort((a, b) => byId[b].dmax - byId[a].dmax);
      if (ids[0]) {
        const rs = freshRows.filter((r) => r.id === ids[0]).sort((a, b) => a.t - b.t);
        const k = rs.findIndex((r) => r.pxNull);
        console.log('--- 取位失效边界摘录（弹 ' + ids[0] + '，覆盖=' + rs[0].cover.toFixed(2) + 's）---');
        if (k < 0) console.log('   本跑该弹未越界（Δmax=' + rs[rs.length - 1].d.toFixed(2) + 's）');
        else for (let q = Math.max(0, k - 3); q < Math.min(rs.length, k + 4); q++) {
          const r = rs[q];
          console.log('   t=' + r.t.toFixed(2) + 's Δ=' + r.d.toFixed(3) + 's 覆盖=' + r.cover.toFixed(2) +
            ' 取位=' + (r.pxNull ? 'null' : '有') + ' 盲区节点=' + r.blind + '/' + r.n);
        }
      }
    }
    console.log('commit=' + commits.length + ' shift med=' + (commits.length ? pct(commits, .5).toFixed(3) : '-') +
      ' max=' + (commits.length ? pct(commits, 1).toFixed(3) : '-') + '  shift>1.0=' + commits.filter((c) => c > 1.0).length);
    console.log('锚点重置(重模拟)事件=' + resim.length + '；涉及弹数=' + new Set(resim.map((r) => r.id)).size +
      '；每 100 帧=' + (100 * resim.length / frames).toFixed(2));
    console.log('diag: desyncs=' + (last ? last.desyncs : 0) + ' missingBullets=' + (last ? last.missing : 0) +
      ' fusedDrop(last)=' + (last ? last.fusedDrop : 'null'));
    console.log('wallMs=' + (Date.now() - t0));
  } catch (e) {
    console.error('FAILED:', (e && e.stack) || e);
    process.exitCode = 1;
  } finally { await m.close(); }
})();
