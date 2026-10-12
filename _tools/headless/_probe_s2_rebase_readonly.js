'use strict';
/* 只读探针（S2）：不改 product code，也不加断言。
 * 目的：量出「段末坍缩 / rebase 之后，保留子节点 rolloutSamples[0] ≈ realTankState」这条
 * 不变量在【当前 build】实际成立与否；并统计 rebase-subtree 事件是否发生（= rebaseSubtreeRigid
 * 是否提前 return 0）。
 * 用法: node _tools/headless/_probe_s2_rebase_readonly.js --frames=600
 */
const { Match } = require('./match');
const SRC = `(() => {
  if (window.__s2Info) return 'exists';
  window.__s2LastN = 0;
  window.__s2Info = function () {
    var t = VantageTree.getTree();
    if (!t) return { ok: false, why: 'no tree' };
    var d = t.diag || {};
    var sh = d.structureHistory || [];
    var n0 = window.__s2LastN || 0;
    var newCodes = [];
    for (var i = n0; i < sh.length; i++) newCodes.push(sh[i].code);
    window.__s2LastN = sh.length;
    var out = { ok: true, t: t.tNow, n: sh.length, newCodes: newCodes, kids: [], tank: null };
    out.tanks = [];
    try {
      var mans = (typeof AIs !== 'undefined' && AIs.aiManagers) ? AIs.aiManagers : [];
      var gc0 = GameManager.getGameController();
      for (var j = 0; j < mans.length; j++) {
        var a = (mans[j] && mans[j].ai && mans[j].ai._vantageAdapter) || (mans[j] && mans[j]._vantageAdapter) || null;
        var pid = (mans[j] && (mans[j].aiId || mans[j].playerId)) || null;
        if (a && pid) { var tk = gc0.getTank(pid);
          if (tk) out.tanks.push({ id: String(pid), x: tk.getX(), y: tk.getY(), rot: tk.getRotation() }); }
      }
      out.rootPose = (t.root && t.root.simState && t.root.simState.tank) ? { x: t.root.simState.tank.x, y: t.root.simState.tank.y } : null;
    } catch (e1) { out.tankErr = String(e1); }
    try {
      var root = t.root, kids = (root && root.children) || [];
      for (var k = 0; k < kids.length; k++) { var c = kids[k];
        var s0 = (c.rolloutSamples && c.rolloutSamples.length) ? c.rolloutSamples[0] : null;
        var tg = (c.simState && c.simState.tank) ? c.simState.tank : null;
        out.kids.push({ id: c.id, s0x: s0 ? s0.x : null, s0y: s0 ? s0.y : null,
          tgx: tg ? tg.x : null, tgy: tg ? tg.y : null });
      }
    } catch (e2) { out.kidErr = String(e2); }
    return out;
  };
  return 'ok';
})()`;
const COLLAPSE = { 'collapse-root-siblings': 1, 'rebase-time': 1, 'rebase-subtree': 1, 'retire-new-root-siblings': 1, 'commit-follow-next': 1, 'fresh-root': 1 };
function q(a, p) { a = a.slice().sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.max(0, Math.floor(p * a.length)))]; }
(async () => {
  const frames = Number((process.argv.find((a) => a.startsWith('--frames=')) || '').split('=')[1] || 600);
  const m = new Match();
  const codes = {}; const dists = []; const cmpDists = []; const examples = []; const matches = {};
  let events = 0, checked = 0, skippedNoTank = 0, skippedNoKid = 0;
  try {
    await m.open({ humanIds: ['tank_a'], aiCount: 1, vantCount: 2 });
    await m.eval(SRC);
    for (let f = 0; f < frames; f++) {
      await m.eval(`(() => { var gc = GameManager.getGameController();
        if (!window.__vpid) { var mans = (typeof AIs !== 'undefined' && AIs.aiManagers) ? AIs.aiManagers : [];
          for (var i = 0; i < mans.length; i++) { var a = (mans[i].ai && mans[i].ai._vantageAdapter) || mans[i]._vantageAdapter; var pid = mans[i].aiId || mans[i].playerId; if (a && pid) { window.__vpid = String(pid); break; } } }
        if (window.__vpid) { var tk = gc.getTank(window.__vpid); if (tk && gc.setTankState) gc.setTankState(TankState.withState(window.__vpid, tk.getX() + 0.03, tk.getY() + 0.02, false, false, tk.getRotation() + 0.05, false, false, false, false), false); }
        window.__vtCtrl.fire = true; return 1; })()`);
      await m.pump(1);
      const s = await m.eval('window.__s2Info()').catch(() => null);
      if (!s || !s.ok) continue;
      const nc = s.newCodes || [];
      for (const c of nc) codes[c] = (codes[c] || 0) + 1;
      if (!nc.some((c) => COLLAPSE[c])) continue;
      events++;
      if (!s.tanks || !s.tanks.length) { skippedNoTank++; continue; }
      if (!s.kids.length) { skippedNoKid++; continue; }
      checked++;
      // 两台 vantage 车都测；"所属车"取距离最小的那台（坍缩后 root 位姿=真实位姿）
      // 归属车用【root 位姿】判（坍缩时 root.simState.tank = 真实位姿），
      // 再用它去量子节点 samples[0]——避免"用子节点距离挑车"的循环论证。
      const owner = (s.rootPose ? s.tanks.slice().sort((a, b) =>
        (Math.hypot(a.x - s.rootPose.x, a.y - s.rootPose.y)) - (Math.hypot(b.x - s.rootPose.x, b.y - s.rootPose.y)))[0] : s.tanks[0]);
      const per = [owner].map((tk) => {
        let wp = 0, wt = 0;
        for (const k of s.kids) {
          if (k.s0x === null) continue;
          const dp = Math.hypot(k.s0x - tk.x, k.s0y - tk.y); if (dp > wp) wp = dp;
          if (k.tgx !== null) { const dt = Math.hypot(k.tgx - tk.x, k.tgy - tk.y); if (dt > wt) wt = dt; }
        }
        return { id: tk.id, wp: wp, wt: wt };
      });
      per.sort((a, b) => a.wp - b.wp);
      const best = per[0];
      dists.push(Math.round(best.wp * 1000) / 1000); cmpDists.push(Math.round(best.wt * 1000) / 1000);
      matches[best.id] = (matches[best.id] || 0) + 1;
      if (examples.length < 6) examples.push({ t: Math.round(s.t * 1000) / 1000, codes: nc.join('+'), nKids: s.kids.length, best: best.id, s0: Math.round(best.wp * 1000) / 1000, tg: Math.round(best.wt * 1000) / 1000, allTanks: per.map((p) => p.id + ':' + (Math.round(p.wp * 100) / 100)), rootPose: s.rootPose });
    }
    await m.clearControl();
    console.log('=== S2 只读核对（坍缩/rebase 之后 samples[0] ≈ realTankState）===');
    console.log('帧=' + frames + ' 结构事件码分布=' + JSON.stringify(codes));
    console.log('坍缩类事件帧=' + events + ' 可核对=' + checked + '（无坦克=' + skippedNoTank + ' 无子节点=' + skippedNoKid + '）');
    if (dists.length) {
      console.log('  |rolloutSamples[0] − realTank|: med=' + q(dists, .5) + ' p90=' + q(dists, .9) + ' max=' + q(dists, 1) + ' m ；>0.15m 的帧=' + dists.filter((d) => d > 0.15).length + '/' + dists.length);
      console.log('  |child.simState.tank − realTank|: med=' + q(cmpDists, .5) + ' p90=' + q(cmpDists, .9) + ' max=' + q(cmpDists, 1) + ' m');
      console.log('  归属车计数=' + JSON.stringify(matches));
      console.log('  样例=' + JSON.stringify(examples));
    }
  } catch (e) { console.error('FAILED:', (e && e.stack) || e); process.exitCode = 1; } finally { await m.close(); }
})();
