'use strict';
/* 时间基准补课（S3/S7/S8）运行期取证探针 —— 只读，不改 game_core。
 *
 * 目的（E1 量级 / E3 / E4 / E8）：
 *   ① Δ = nowTGlobal - anchorOffset 的实测分布（= S3 少给的秒数、也是 S8 多扣的上限量级）
 *   ② S7 触发频率：融合批次里 (tGlobal≈0 且 nowTGlobal>0.05) 的批次数
 *      ——这些批次的真实弹体位姿是"现在"的，却被当成节点起点的
 *   ③ S8 触发频率：经 VantageScoring.scorePaths 走的批次（audit purpose='unknown'）
 *      里 tGlobal>0 且 nowTGlobal>0 的批次数 + 它们的 qAge 多扣 = min(tGlobal, nowTGlobal)
 *   ④ E8：树威胁表里有、但实时 projectile 取不到的弹（rescore 会退回 lifeLeftSeconds=10）
 *
 * 用法：node _tools/headless/_probe_tbase_s7s8.js [--frames 1200]
 */
const { Match } = require('./match');

const PROBE_SRC = `(() => {
  if (window.__tbProbe) return 'exists';
  window.__tbState = { frames: 0 };
  window.__tbProbe = function () {
    var out = { ok: true, tNow: null, rootAbsT: null, anchors: [], batches: [], threatIds: [], projIds: [] };
    try {
      var d = (typeof VantageTree !== 'undefined' && VantageTree.dumpDiagnostics) ? VantageTree.dumpDiagnostics() : null;
      if (d) {
        out.tNow = d.tNow; out.rootAbsT = d.rootAbsT;
        out.anchors = (d.diag && d.diag.anchorProbe) ? d.diag.anchorProbe : [];
        out.threatIds = (d.threats || []).map(function (t) { return t && t.id; });
        out.threatCount = (d.threats || []).length;
      }
    } catch (e) { out.treeErr = String(e && e.message || e); }
    try {
      var gc = GameManager.getGameController();
      var pj = gc ? gc.getProjectiles() : null;
      if (pj) for (var k in pj) {
        if (!pj.hasOwnProperty(k)) continue;
        var po = pj[k];
        out.projIds.push(po && po.id !== undefined ? po.id : k);
        if (po) {
          out.projs = out.projs || {};
          var pid = (po && po.id !== undefined) ? String(po.id) : String(k);
          var pb = (po.getB2DBody ? po.getB2DBody() : null);
          if (pb) {
            var pp = pb.GetPosition(), pv = pb.GetLinearVelocity();
            out.projs[pid] = { x: pp.x, y: pp.y, vx: pv.x, vy: pv.y };
          }
        }
      }
    } catch (e2) { out.projErr = String(e2 && e2.message || e2); }
    try {
      var mans = (typeof AIs !== 'undefined' && AIs.aiManagers) ? AIs.aiManagers : [];
      out.aiInfo = [];
      for (var i = 0; i < mans.length; i++) {
        var mi = mans[i];
        var ks = [];
        for (var kk in mi) { if (kk.indexOf('vantage') >= 0 || kk.indexOf('Adapter') >= 0 || kk === 'aiId' || kk === 'playerId') ks.push(kk); }
        var miAd = (mi.ai && mi.ai._vantageAdapter) || mi._vantageAdapter || null;
        out.aiInfo.push({ i: i, hasAd: !!miAd,
          hist: (miAd && miAd.getFusedBatchAuditHistory) ? miAd.getFusedBatchAuditHistory().length : -1 });
      }
      for (var i = 0; i < mans.length; i++) {
        var a = (mans[i] && mans[i].ai && mans[i].ai._vantageAdapter)
          || (mans[i] && mans[i]._vantageAdapter) || null;
        if (!a || !a.getFusedBatchAuditHistory) continue;
        var h = a.getFusedBatchAuditHistory();
        for (var j = 0; j < h.length; j++) out.batches.push(h[j]);
      }
    } catch (e3) { out.aiErr = String(e3 && e3.message || e3); }
    return out;
  };
  return 'ok';
})()`;

function pct(sorted, p) { return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]; }

(async () => {
  const frames = Number((process.argv.find((a) => a.startsWith('--frames=')) || '').split('=')[1] || 1200);
  const m = new Match();
  const seen = {};
  const deltas = [];             // Δ = tNow - abs0
  const s7Batches = [];          // tGlobal≈0 且 nowTGlobal>0.05
  const s8Batches = [];          // purpose=unknown && tGlobal>1e-6
  const noProj = [];             // E8：威胁有、projectile 取不到
  const purposeCount = {};
  const purposeStat = {};
  const byAnchor = {};
  let framesSeen = 0, projSeen = 0;
  try {
    await m.open({ humanIds: ['tank_a'], aiCount: 1, vantCount: 2 });
    await m.eval(PROBE_SRC);
    // 造弹：把 tank_a 放在 vantage_1 附近并持续开火
    let fired = 0;
    for (let f = 0; f < frames; f += 10) {
      await m.pump(10);
      framesSeen += 10;
      if (f % 100 === 0) {
        // 只让 tank_a 原地缓慢转圈开火（弹满场飞 → 树的威胁表有料），
        // 不瞄准 vantage 坦克（否则会打死它 → 树冻结 → 采不到融合批次）
        const rot = (f / 100) * 0.9;
        await m.eval(`(() => {
          var gc = GameManager.getGameController();
          var a = gc.getTank('tank_a');
          if (a && gc.setTankState) {
            gc.setTankState(TankState.withState('tank_a', a.getX(), a.getY(), false, false, ${rot}, false, false, false, false), false);
          }
          return 1;
        })()`);
        fired++;
      }
      if (f % 100 === 0) {
        const dbg = (f % 300 === 0) ? await m.eval(`(() => {
          var out = {};
          try {
            var gc = GameManager.getGameController();
            out.state = gc ? gc.getState() : null;
            out.tanks = [];
            var ts = gc ? gc.getTanks() : null;
            for (var k in ts) if (ts.hasOwnProperty(k)) out.tanks.push(k);
            var d = (typeof VantageTree !== 'undefined') ? VantageTree.dumpDiagnostics() : null;
            out.front = gc ? gc.isRoundStarted && gc.isRoundStarted() : null;
          } catch (e) { out.err = String(e && e.message || e); }
          try {
            var d2 = VantageTree.dumpDiagnostics();
            out.nodes = d2 ? d2.shape.nodeCount : null;
            out.tNow = d2 ? d2.tNow : null;
            out.events = d2 ? (d2.events || []).slice(-3).map(function (ev) { return ev.type + ':' + String(ev.info).slice(0, 40); }) : null;
            out.stats = d2 ? JSON.stringify(d2.stats).slice(0, 220) : null;
          } catch (e2) { out.treeErr = String(e2 && e2.message || e2); }
          return out;
        })()`) : null;
        if (dbg) console.log('  [帧' + f + '] nodes=' + dbg.nodes + ' tNow=' + (dbg.tNow && dbg.tNow.toFixed(2)) +
          ' tanks=' + JSON.stringify(dbg.tanks) + ' commits=' + (dbg.stats || '').slice(0, 80));
      }
      await m.eval("window.__vtCtrl.fire = true");
      const s = await m.eval('window.__tbProbe()');
      if (!s || !s.ok) continue;
      const tNow = s.tNow, rootAbsT = s.rootAbsT;
      if (typeof tNow === 'number') {
        for (const a of (s.anchors || [])) {
          if (a && typeof a.abs0 === 'number') {
            const d = tNow - a.abs0;
            deltas.push({ d: d, id: a.id, tNow: tNow, abs0: a.abs0, len: a.len, v0: a.v0, vr: a.vr, drift: a.drift });
            const ab = byAnchor[a.id] || (byAnchor[a.id] = { n: 0, min: Infinity, max: -Infinity, len: a.len });
            ab.n++; ab.min = Math.min(ab.min, d); ab.max = Math.max(ab.max, d);
          }
        }
      }
      // 威胁表有、projectile 取不到
      const pjSet = {};
      for (const p of (s.projIds || [])) pjSet[String(p)] = 1;
      for (const tid of (s.threatIds || [])) {
        if (!pjSet[String(tid)]) noProj.push({ t: tNow, id: tid, projCount: (s.projIds || []).length });
      }
      projSeen += (s.projIds || []).length;
      for (const b of (s.batches || [])) {
        if (b.seq !== undefined && seen[b.seq]) continue;
        if (b.seq !== undefined) seen[b.seq] = 1;
        purposeCount[b.purpose] = (purposeCount[b.purpose] || 0) + 1;
        const tg = b.tGlobal || 0, nt = b.nowTGlobal || 0;
        const ps = purposeStat[b.purpose] || (purposeStat[b.purpose] = { n: 0, tgMax: 0, tgMed: [], ntMax: 0, ntMed: [],
          tg0_ntPos: 0, tgPos_ntPos: 0, tgPos_ntZero: 0, tg0_ntZero: 0 });
        ps.n++;
        ps.tgMax = Math.max(ps.tgMax, tg); ps.tgMed.push(tg);
        ps.ntMax = Math.max(ps.ntMax, nt); ps.ntMed.push(nt);
        if (tg <= 1e-6 && nt > 0.05) ps.tg0_ntPos++;
        else if (tg > 1e-6 && nt > 0.05) ps.tgPos_ntPos++;
        else if (tg > 1e-6) ps.tgPos_ntZero++;
        else ps.tg0_ntZero++;
        if (tg <= 1e-6 && nt > 0.05 && (b.placements || []).length) {
          const cmp = [];
          for (const pl of (b.placements || [])) {
            const rp = (s.projs && pl.pid !== null && pl.pid !== undefined) ? s.projs[String(pl.pid)] : null;
            if (!rp) { cmp.push({ pid: pl.pid, src: pl.src, noReal: true }); continue; }
            const obs = { dx: pl.x - rp.x, dy: pl.y - rp.y };
            const exp = { dx: -rp.vx * nt, dy: -rp.vy * nt };
            const dObs = Math.hypot(obs.dx, obs.dy), dExp = Math.hypot(obs.dx - exp.dx, obs.dy - exp.dy);
            cmp.push({ pid: pl.pid, src: pl.src, obs: Math.round(dObs * 100) / 100,
              vsBack: Math.round(dExp * 100) / 100,
              v: Math.round(Math.hypot(rp.vx, rp.vy) * nt * 100) / 100 });
          }
          s7Batches.push({ seq: b.seq, purpose: b.purpose, tg: tg, nt: nt, tNow: typeof tNow === 'number' ? tNow : null,
            real: (b.placements || []).filter((p) => p.src === 'real').length,
            total: (b.placements || []).length, cmp: cmp,
            sample: (b.placements || []).slice(0, 3) });
        }
        if (b.purpose === 'unknown' && tg > 1e-6) {
          s8Batches.push({ seq: b.seq, tg: tg, nt: nt, over: Math.min(tg, nt), tNow: tNow });
        }
      }
    }
    await m.clearControl();
    const ds = deltas.map((x) => x.d).sort((a, b) => a - b);
    console.log('=== 探针（时间基准补课 S3/S7/S8） ===');
    console.log('帧数=' + framesSeen + '  采到 anchors 样本=' + ds.length + '  projectile 累计=' + projSeen);
    if (ds.length) {
      console.log('Δ = nowTGlobal - anchorOffset（秒）: min=' + ds[0].toFixed(4) +
        ' median=' + pct(ds, 0.5).toFixed(4) + ' p90=' + pct(ds, 0.9).toFixed(4) +
        ' p99=' + pct(ds, 0.99).toFixed(4) + ' max=' + ds[ds.length - 1].toFixed(4));
      console.log('  换算成帧（FRAME=0.02）: median=' + (pct(ds, 0.5) / 0.02).toFixed(1) +
        ' p90=' + (pct(ds, 0.9) / 0.02).toFixed(1) + ' max=' + (ds[ds.length - 1] / 0.02).toFixed(1));
      const over = ds.filter((d) => d >= 0.02).length;
      console.log('  Δ≥1 帧的样本占比 = ' + (100 * over / ds.length).toFixed(1) + '%');
    } else {
      console.log('Δ : 无样本（树没跑/没弹）');
    }
    console.log('融合批次 purpose 分布 = ' + JSON.stringify(purposeCount));
    for (const p2 of Object.keys(purposeStat)) {
      const q = purposeStat[p2];
      const med = (arr2) => { const a = arr2.slice().sort((x, y) => x - y); return pct(a, 0.5); };
      console.log('  [' + p2 + '] n=' + q.n + ' tGlobal med=' + med(q.tgMed).toFixed(3) + '/max=' + q.tgMax.toFixed(3) +
        '  nowTGlobal med=' + med(q.ntMed).toFixed(3) + '/max=' + q.ntMax.toFixed(3) +
        '  | tGlobal≈0&now>0.05=' + q.tg0_ntPos + '  tGlobal>0&now>0.05=' + q.tgPos_ntPos +
        '  tGlobal>0&now=0=' + q.tgPos_ntZero + '  双0=' + q.tg0_ntZero);
    }
    const abIds = Object.keys(byAnchor);
    abIds.sort((a, b2) => byAnchor[b2].max - byAnchor[a].max);
    console.log('按威胁（anchor id）看 Δ: 共 ' + abIds.length + ' 个威胁');
    for (const id of abIds.slice(0, 8)) {
      const ab = byAnchor[id];
      console.log('   ' + id + ': 采样' + ab.n + ' Δmin=' + ab.min.toFixed(3) + ' Δmax=' + ab.max.toFixed(3) + ' trackLen=' + ab.len);
    }
    console.log('S7（tGlobal≈0 且 nowTGlobal>0.05，有摆弹）批次数 = ' + s7Batches.length);
    const s7real = s7Batches.reduce((a, b) => a + b.real, 0);
    const s7tot = s7Batches.reduce((a, b) => a + b.total, 0);
    console.log('   其中 src=\'real\' 摆弹数 = ' + s7real + ' / ' + s7tot);
    if (s7Batches.length) {
      const nts = s7Batches.map((b) => b.nt).sort((a, b) => a - b);
      console.log('   nowTGlobal: median=' + pct(nts, 0.5).toFixed(3) + ' max=' + nts[nts.length - 1].toFixed(3) +
        '  ⇒ 弹位误差(×18m/s): median=' + (pct(nts, 0.5) * 18).toFixed(2) + 'm max=' + (nts[nts.length - 1] * 18).toFixed(2) + 'm');
      let nBack = 0, nReal = 0, nOther = 0, worst = 0;
      const details = [];
      for (const b of s7Batches) {
        for (const c of (b.cmp || [])) {
          if (c.noReal) { details.push({ pid: c.pid, src: c.src, note: '实时弹取不到' }); continue; }
          if (c.obs < 0.05) { nReal++; details.push({ pid: c.pid, src: c.src, note: '仍是"现在"弹位(未移动)' }); }
          else if (c.vsBack < 0.05) { nBack++; worst = Math.max(worst, c.obs); details.push({ pid: c.pid, src: c.src, note: '已反推', moved: c.obs, }); }
          else { nOther++; worst = Math.max(worst, c.obs); details.push({ pid: c.pid, src: c.src, obs: c.obs, vsBack: c.vsBack }); }
        }
      }
      console.log('   位置对拍: 未移动(≈现在弹位)=' + nReal + '  已按 -v·tBack 反推=' + nBack +
        '  其它=' + nOther + '（反推距离最大 ' + worst.toFixed(2) + 'm）');
      console.log('   逐弹: ' + JSON.stringify(details.slice(0, 6)));
      console.log('   样例: ' + JSON.stringify(s7Batches.slice(0, 2)));
    }
    console.log('S8（purpose=unknown 且 tGlobal>0）批次数 = ' + s8Batches.length);
    if (s8Batches.length) {
      const overs = s8Batches.map((b) => b.over).sort((a, b) => a - b);
      const tgs = s8Batches.map((b) => b.tg).sort((a, b) => a - b);
      console.log('   多扣寿命 = min(tGlobal,nowTGlobal): median=' + pct(overs, 0.5).toFixed(3) +
        ' p90=' + pct(overs, 0.9).toFixed(3) + ' max=' + overs[overs.length - 1].toFixed(3) + ' 秒');
      console.log('   tGlobal: median=' + pct(tgs, 0.5).toFixed(3) + ' max=' + tgs[tgs.length - 1].toFixed(3) +
        '   nowTGlobal: median=' + pct(s8Batches.map((b) => b.nt).sort((a, b) => a - b), 0.5).toFixed(3));
      console.log('   样例: ' + JSON.stringify(s8Batches.slice(0, 3)));
    }
    console.log('E8（威胁表里有、实时 projectile 取不到）次数 = ' + noProj.length);
    if (noProj.length) console.log('   样例: ' + JSON.stringify(noProj.slice(0, 3)));
    const errs = (await m.stats()).errors || [];
    console.log('页面错误数 = ' + errs.length + (errs.length ? ' 例: ' + String(errs[0]).slice(0, 200) : ''));
  } catch (e) {
    console.error('FAILED:', (e && e.stack) || e);
    process.exitCode = 1;
  } finally { await m.close(); }
})();
