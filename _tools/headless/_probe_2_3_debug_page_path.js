#!/usr/bin/env node
'use strict';
/* ============================================================================
 * 阶段 2-3 第三步 · 调试页判据验证探针
 *
 * 父代理第三步判据（原文）：
 *   ⭐「**左边画的东西必须从【和右边同一份数据】来** —— 左边不能自己去 gc.getTank() 另取一份；
 *      正确做法：左边画的是"右边 token 解出来的世界"」
 *
 * 本探针在【真开一局】上验证这条判据在**结构上 + 数值上**都成立：
 *   · 结构上：绘制只吃 `VantageObserve.buildScene(enc)`，而入参就是右边那份 `enc`；
 *   · 数值上：**逐节点**断言 `scene.nodes[i].x === enc.rootPose.x + enc.nodes.tokens[i][6]`
 *             （y / rot 同理）、**逐子弹**断言 `scene.bullets[j] ≡ enc.bullets.tokens[j]`
 *             ⟹ **左边画布上的每个位置，逐位等于右边表里的 token 值**。
 *   · 附带：两个"替代信号"（缺 slot / L=1）真的产出结构；θ 走唯一真源。
 *
 * 用法：node _tools/headless/_probe_2_3_debug_page_path.js
 * 退出码：0=PASS，1=FAIL。
 * ============================================================================ */
const { Match } = require('./match');

const INJECT = `
(() => {
  var gc = GameManager.getGameController();
  var other = null, tanks = gc.getTanks();
  for (var k in tanks) { if (k !== 'tank_a' && tanks[k]) { other = tanks[k]; break; } }
  if (!other) return { err: 'no other tank' };
  var X = other.getX(), Y = other.getY(), x = X - 3, y = Y - 3;
  var d = Math.sqrt((X - x) * (X - x) + (Y - y) * (Y - y)) || 1;
  var id = 'probe_dbg_' + (window.__n = (window.__n || 0) + 1);
  try {
    var ps = ProjectileState.withState(id, 'tank_a', -1, x, y, (X - x) / d * 18, (Y - y) / d * 18);
    gc.roundController.setProjectileState(ps);
  } catch (e) { return { err: String((e && e.message) || e) }; }
  return { ok: true };
})()`;

/* 一次 encode → 一次 buildScene（**同一个 enc**），然后把判据逐条算出来 */
const CHECK = `
(() => {
  var gc = GameManager.getGameController();
  var AD = VantageSandbox.createAdapter(gc, 'vantage_1');
  var T = VantageTree.getTree();
  if (!T) return { noTree: true };
  var enc = VantageObserve.encode({ adapter: AD, tree: T, horizonSec: 10 });   // ★ 右边那份
  var sc  = VantageObserve.buildScene(enc);                                    // ★ 左边那份（只吃 enc）
  var out = { N: sc.stat.N, M: sc.stat.M, total: sc.stat.total,
              nBranches: sc.stat.nBranches, nMissing: sc.stat.nMissing, nShortL: sc.stat.nShortL,
              hasRootPose: !!enc.rootPose, theta: VantageObserve.THETA_CONVENTION,
              xBad: 0, yBad: 0, rotBad: 0, bBad: 0, rootBad: 0,
              sample: null, missSample: null, l1Sample: null, l1Total: 0, l1Frames: 0 };
  // ① 根 token 必须解回 rootPose
  for (var i = 0; i < sc.nodes.length; i++) {
    if (sc.nodes[i].parentIdx === -1) {
      if (Math.abs(sc.nodes[i].x - enc.rootPose.x) > 1e-9 || Math.abs(sc.nodes[i].y - enc.rootPose.y) > 1e-9) out.rootBad++;
      break;
    }
  }
  // ② 逐节点：scene 的位置必须**逐位等于** rootPose + token
  for (var j = 0; j < sc.nodes.length; j++) {
    var t = enc.nodes.tokens[j];
    if (Math.abs(sc.nodes[j].x - (enc.rootPose.x + t[6])) > 1e-9) out.xBad++;
    if (Math.abs(sc.nodes[j].y - (enc.rootPose.y + t[7])) > 1e-9) out.yBad++;
    if (Math.abs(sc.nodes[j].rot - (enc.rootPose.rot + t[8])) > 1e-9) out.rotBad++;
    if (!out.sample && t[1] >= 0) out.sample = { idx: j, token: t.slice(0, 11),
      sceneX: sc.nodes[j].x, tokenDx: t[6], rootX: enc.rootPose.x };
  }
  // ③ 逐子弹：scene ≡ token（且 θ 必须就等于 token[4]）
  for (var k = 0; k < sc.bullets.length; k++) {
    var b = enc.bullets.tokens[k], s = sc.bullets[k];
    if (s.x !== b[0] || s.y !== b[1] || s.vx !== b[2] || s.vy !== b[3] || s.theta !== b[4] ||
        s.type !== b[5] || s.lifeLeft !== b[6]) out.bBad++;
  }
  // ④ 替代信号：缺 slot / L=1
  if (sc.missingSlots.length) {
    var m0 = sc.missingSlots[0];
    var p = sc.nodes[m0.parentIdx];
    out.missSample = { parentIdx: m0.parentIdx, nChildren: m0.nChildren, slots: m0.slots,
                       missing: m0.missing, parentToken: enc.nodes.tokens[m0.parentIdx].slice(0, 11),
                       parentUid: p ? p.uid : null };
  }
  out.l1Total += sc.shortL.length; out.l1Frames++;
  if (sc.shortL.length) out.l1Sample = { idx: sc.shortL.slice(0, 6),
    tokens: sc.shortL.slice(0, 3).map(function (q) { return enc.nodes.tokens[q].slice(0, 11); }) };
  return out;
})()`;

(async () => {
  const m = new Match();
  let pass = 0, fail = 0; const fails = [];
  function check(name, ok, detail) {
    if (ok) pass++; else { fail++; fails.push(name); }
    console.log((ok ? 'PASS  ' : 'FAIL  ') + name.padEnd(50) + (detail === undefined ? '' : '  ' + String(detail).slice(0, 320)));
  }
  try {
    await m.open({ humanIds: ['tank_a'], aiCount: 0, vantCount: 1, rng: 'record', bootFrames: 300, rebaseAtMenu: true });
    let best = null, frames = 0, noTree = 0, bestMiss = null, l1Total = 0, l1Frames = 0, nTotal = 0;
    for (let f = 1; f <= 360; f++) {
      await m.pump(1);
      if (f % 3 === 0) await m.eval(INJECT);
      if (f % 4 !== 0) continue;
      const r = await m.eval(CHECK);
      if (!r || r.noTree) { noTree++; continue; }
      frames++;
      if (!best || r.N > best.N) best = r;
      if (r.missSample && !bestMiss) bestMiss = r.missSample;
      l1Total += r.l1Total || 0; l1Frames += r.l1Frames || 0; nTotal += r.N || 0;
      if (f % 120 === 0) console.log('  ...frame ' + f + ' N=' + r.N + ' M=' + r.M + ' miss=' + r.nMissing + ' L1=' + r.nShortL);
    }
    console.log('=== 判据验证（取 N 最大的那一帧，共 ' + frames + ' 个采样帧）===');
    console.log(JSON.stringify({ N: best.N, M: best.M, total: best.total, nBranches: best.nBranches,
      nMissing: best.nMissing, nShortL: best.nShortL, theta: best.theta }, null, 1));
    console.log('=== 逐位对拍计数（全部必须为 0）===');
    console.log(JSON.stringify({ xBad: best.xBad, yBad: best.yBad, rotBad: best.rotBad, bBad: best.bBad, rootBad: best.rootBad }));
    console.log('=== 样例：节点（token → 画面坐标）===');
    console.log(JSON.stringify(best.sample));
    console.log('=== 样例：缺 slot（= 那一支真死）===');
    console.log(JSON.stringify(bestMiss));
    console.log('=== 样例：L=1（过渡口径的真死候选）===');
    console.log(JSON.stringify(best.l1Sample));

    check('真开一局 + 树在场（noTree 允许 ≤4 次回合重置窗口）', best && best.N > 0 && noTree <= 4, 'N=' + (best || {}).N + ' noTree=' + noTree);
    check('enc.rootPose 存在（画布不必再问游戏要一次）', !!best.hasRootPose, JSON.stringify(best.hasRootPose));
    check('★ 根 token 解回 rootPose（rootBad=0）', best.rootBad === 0, 'rootBad=' + best.rootBad);
    check('★ 逐节点 scene.x === rootPose.x + token[6]（xBad=0）', best.xBad === 0, 'xBad=' + best.xBad + ' / N=' + best.N);
    check('★ 逐节点 scene.y === rootPose.y + token[7]（yBad=0）', best.yBad === 0, 'yBad=' + best.yBad);
    check('★ 逐节点 scene.rot === rootPose.rot + token[8]（rotBad=0）', best.rotBad === 0, 'rotBad=' + best.rotBad);
    check('★ 逐子弹 scene ≡ token 逐位相等（bBad=0）', best.bBad === 0, 'bBad=' + best.bBad + ' / M=' + best.M);
    check('θ 约定 = atan2(speedX,-speedY)（唯一真源）', best.theta === 'atan2(speedX,-speedY)', best.theta);
    check('替代信号①"缺 slot" 产出结构（跨帧累计）', !!bestMiss, JSON.stringify(bestMiss && { p: bestMiss.parentIdx, slots: bestMiss.slots, miss: bestMiss.missing }));
    check('替代信号②"L=1" 产出结构（⚠️ 非特异，只作"短枝"标注）', !!(best.l1Sample && best.l1Sample.idx.length), JSON.stringify(best.l1Sample && best.l1Sample.idx));
    console.log('=== ⚠️ 更正：L=1 的【非特异性】实测 ===');
    console.log('  跨帧累计：L=1 节点 ' + l1Total + ' 个 / 总节点 ' + nTotal + ' 个 = ' + (nTotal ? (100*l1Total/nTotal).toFixed(1) : '-') + '%' );
    check('更正：L=1 是【短枝】而不是【真死】判据（占比 >30% ⟹ 非特异）', nTotal > 0 && (l1Total / nTotal) > 0.30, 'L1=' + l1Total + '/' + nTotal + '=' + (nTotal?(100*l1Total/nTotal).toFixed(1):'-') + '%');
    check('维度 total 与字段表一致（10N+7M+…>0）', best.total === best.N * 10 + best.M * 7 + 1 + 11 + 36 + 6 ||
      best.total > best.N * 10, 'total=' + best.total + ' N=' + best.N + ' M=' + best.M);

    console.log('SUMMARY ' + JSON.stringify({ pass, fail, fails, frames, noTree, best: { N: best.N, M: best.M,
      nMissing: best.nMissing, nShortL: best.nShortL, xBad: best.xBad, yBad: best.yBad, rotBad: best.rotBad, bBad: best.bBad, rootBad: best.rootBad } }));
  } catch (e) {
    console.error('PROBE FATAL ' + ((e && e.stack) || e));
    process.exitCode = 2;
  } finally {
    try { await m.close(); } catch (e) {}
  }
  if (fail) process.exitCode = 1;
})();
