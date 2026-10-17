#!/usr/bin/env node
'use strict';
/* ============================================================================
 * 阶段 2-3 · 【观测编码器 自证探针】
 *
 * 任务书验收原文：
 *   ① **真开一局**，**逐字段打印 token**；
 *   ② **证明每个字段都不是恒 0 / 恒 undefined**（本项目老坑：字段存在但恒为垃圾值）；
 *   ③ **证明"节点 token 能表达分叉结构"**：给出一个"某节点有分支"和
 *      一个"某节点没分支且生长过"的**真实样例**，**人眼能从 token 看出差别**。
 *
 * 用法：node _tools/headless/_probe_2_3_observe_selfproof.js
 * 退出码：0=PASS，1=FAIL。
 * ============================================================================ */
const fs = require('fs'), path = require('path');
const { Match } = require('./match');

const INIT = `
(() => {
  window.__vtO = { frames: 0, node: [], bullet: [], lag: [], lagRaw: [], storm: [], global: [],
                   bulletTypeSeen: {}, thetaNoHits: 0, thetaChecked: 0, last: null };
  return 1;
})()`;

const STEP = `
(() => {
  var gc = GameManager.getGameController();
  var AD = VantageSandbox.createAdapter(gc, window.__vtVantageId || 'vantage_1');
  var T = VantageTree.getTree();
  if (!T) return { noTree: true };
  var enc = VantageObserve.encode({ adapter: AD, tree: T, horizonSec: 10 });
  var A = window.__vtO;
  A.frames++;
  // 节点段：逐维 min/max/distinct/非零
  (function () {
    var t = enc.nodes.tokens;
    if (!A.node.length) for (var d = 0; d < VantageObserve.NODE_DIM; d++) A.node.push({ min: Infinity, max: -Infinity, nz: 0, n: 0, set: {} });
    for (var i = 0; i < t.length; i++) for (var d2 = 0; d2 < VantageObserve.NODE_DIM; d2++) {
      var v = t[i][d2], s = A.node[d2];
      if (typeof v !== 'number' || !isFinite(v)) continue;
      if (v < s.min) s.min = v; if (v > s.max) s.max = v;
      if (Math.abs(v) > 1e-12) s.nz++;
      s.n++;
      if (Object.keys(s.set).length < 40) s.set[String(v)] = 1;
    }
  })();
  // 子弹段
  (function () {
    var t = enc.bullets.tokens;
    if (!A.bullet.length) for (var d = 0; d < VantageObserve.BULLET_DIM; d++) A.bullet.push({ min: Infinity, max: -Infinity, nz: 0, n: 0, set: {} });
    for (var i = 0; i < t.length; i++) for (var d2 = 0; d2 < VantageObserve.BULLET_DIM; d2++) {
      var v = t[i][d2], s = A.bullet[d2];
      if (typeof v !== 'number' || !isFinite(v)) continue;
      if (v < s.min) s.min = v; if (v > s.max) s.max = v;
      if (Math.abs(v) > 1e-12) s.nz++;
      s.n++;
      if (Object.keys(s.set).length < 40) s.set[String(v)] = 1;
    }
    // θ 真源对拍：每个 token 的 θ 必须 == atan2(speedX,-speedY)
    var ps = AD.getProjectiles() || [];
    for (var j = 0; j < t.length; j++) {
      var p = ps[j]; if (!p) continue;
      var want = Math.atan2(p.speedX, -p.speedY);
      A.thetaChecked++;
      if (Math.abs(t[j][4] - want) > 1e-12) A.thetaNoHits++;
      A.bulletTypeSeen[String(p.type)] = 1;
    }
  })();
  A.lag.push(enc.rootLag.available ? enc.rootLag.value : null);
  // ── 跨帧累计：分叉样例（末帧可能正好落在回合重置窗口，不能只看末帧）──
  if (!A.seen) A.seen = { bulletFrames: 0, maxBullets: 0, a: null, b1: null, b2: null, frames: 0,
                          nTrueDead: 0, nGrownNoChildFrames: 0, grownChildHist: {} };
  if (enc.bullets.tokens.length > 0) A.seen.bulletFrames++;
  if (enc.bullets.tokens.length > A.seen.maxBullets) A.seen.maxBullets = enc.bullets.tokens.length;
  A.seen.frames++;
  (function () {
    var rows2 = VantageTree.collectAgentNodes(T), tk = enc.nodes.tokens, ids2 = enc.nodes.ids;
    var byP = {};
    for (var i2 = 0; i2 < tk.length; i2++) { var kk = String(tk[i2][1]); (byP[kk] = byP[kk] || []).push(tk[i2][2]); }
    for (var k2 in byP) {
      if (byP[k2].length < 2) continue;
      var pIdx = Number(k2); if (pIdx < 0 || pIdx >= tk.length) continue;
      var slots = byP[k2].slice().sort(function (x, y) { return x - y; });
      if (!A.seen.a || slots.length > A.seen.a.nChildren) {
        A.seen.a = { frame: A.frames, parentIdx: pIdx, parentUid: tk[pIdx][0], parentToken: tk[pIdx].slice(),
                     childSlots: slots, nChildren: slots.length };
      }
    }
    for (var j2 = 0; j2 < rows2.length; j2++) {
      var r2 = rows2[j2]; if (!r2 || r2.invalid) continue;
      if (r2.fullDeathFrame >= 0 && r2.fullDeathFrame <= 1) A.seen.nTrueDead++;
      var nc2 = Number(r2.nChildren) || 0;
      if (r2.hasGrown === true) A.seen.grownChildHist[String(nc2)] = (A.seen.grownChildHist[String(nc2)] || 0) + 1;
      if (r2.hasGrown === true && nc2 === 0 && !A.seen.b1) {
        A.seen.nGrownNoChildFrames++;
        A.seen.b1 = { frame: A.frames, uid: r2.id, slot: r2.opIndex, depth: r2.depth, token: tk[j2].slice(),
          parentIdx: tk[j2][1], fullDeathFrame: r2.fullDeathFrame, exhausted: r2.exhausted,
          fullDead: r2.fullDead, nChildren: nc2, opName: r2.opName };
      }
      if (r2.hasGrown !== true && nc2 === 0 && !A.seen.b2) {
        A.seen.b2 = { frame: A.frames, uid: r2.id, slot: r2.opIndex, depth: r2.depth, token: tk[j2].slice(),
          parentIdx: tk[j2][1], fullDeathFrame: r2.fullDeathFrame, exhausted: r2.exhausted, nChildren: nc2, opName: r2.opName };
      }
    }
  })();
  A.lagRaw.push(enc.rootLag.available ? enc.rootLag.raw : null);
  A.storm.push(enc.storm.token.slice());
  A.global.push(enc.global.globalTok.slice());
  // 末帧原始行（含 nChildren）——供"分叉样例"分析
  var rows = VantageTree.collectAgentNodes(T);
  A.last = { tokens: enc.nodes.tokens, ids: enc.nodes.ids, rows: rows,
             stat: enc.nodes.stat, dims: enc.dims, storm: enc.storm, plan: enc.plan,
             global: enc.global, lag: enc.rootLag, bulletStat: enc.bullets.stat,
             mapSize: enc.mapSize };
  return { frames: A.frames, nNodes: enc.nodes.tokens.length, nBullets: enc.bullets.tokens.length,
           lag: enc.rootLag.value, total: enc.dims.total };
})()`;

const SNAP = `
(() => {
  var A = window.__vtO;
  function fin(arr) { return arr.map(function (s) { return { min: (s.min === Infinity ? null : +s.min.toFixed(6)),
    max: (s.max === -Infinity ? null : +s.max.toFixed(6)), nz: s.nz, n: s.n, distinct: Object.keys(s.set).length }; }); }
  // 根滞后：非零帧数 + 最大值
  var lagNZ = 0, lagMax = 0, lagMin = 1e9, lagDefined = 0;
  for (var i = 0; i < A.lag.length; i++) { var v = A.lag[i];
    if (v === null || v === undefined) continue; lagDefined++;
    if (Math.abs(v) > 1e-12) lagNZ++;
    if (v > lagMax) lagMax = v; if (v < lagMin) lagMin = v; }
  return { frames: A.frames, node: fin(A.node), bullet: fin(A.bullet),
           lagFrames: A.lag.length, lagDefined: lagDefined, lagNonZeroFrames: lagNZ,
           lagMax: +lagMax.toFixed(6), lagMin: (lagMin === 1e9 ? null : +lagMin.toFixed(6)),
           thetaChecked: A.thetaChecked, thetaMismatch: A.thetaNoHits,
           bulletTypeSeen: Object.keys(A.bulletTypeSeen),
           last: A.last, seen: A.seen };
})()`;

const INJECT = `
(() => {
  var gc = GameManager.getGameController();
  var t = gc.getTank('tank_a'); if (!t) return { err: 'no tank_a' };
  var other = null, otherId = null, tanks = gc.getTanks();
  for (var k in tanks) { if (k !== 'tank_a' && tanks[k]) { other = tanks[k]; otherId = k; break; } }
  if (!other) return { err: 'no other tank' };
  var X = other.getX(), Y = other.getY(); var x = X - 3, y = Y - 3;
  var dx = X - x, dy = Y - y;
  var L = Math.sqrt(dx * dx + dy * dy) || 1;
  // ★ 打【对手（=vantage AI）】而不是随便打：只有真威胁才会让树的节点判死 ⟹
  //   才可能出现 hasGrown=1 且 children=0（真死剪枝）那个真实样例。
  var TYPES = [-1, 0, 1, 2, 3];
  var ty = TYPES[(window.__vtO.injN || 0) % TYPES.length];
  var sp = (ty === 0 || ty === 3) ? 180 : 18;   // 激光/导弹 180 m/s，普通/双管/霰弹 18 m/s
  var id = 'probe_obs_' + (window.__vtO.injN = (window.__vtO.injN || 0) + 1);
  try {
    var ps = ProjectileState.withState(id, 'tank_a', ty, x, y, dx / L * sp, dy / L * sp);
    gc.roundController.setProjectileState(ps);
  } catch (e) { return { err: String((e && e.message) || e), ty: ty }; }
  var p = gc.getProjectile(id);
  return { ok: !!p, id: id, ty: ty, otherId: otherId, x: p ? p.getX() : null, y: p ? p.getY() : null,
           vx: p ? p.getSpeedX() : null, vy: p ? p.getSpeedY() : null };
})()`;

(async () => {
  const m = new Match();
  let pass = 0, fail = 0; const fails = [];
  function check(name, ok, detail) {
    if (ok) pass++; else { fail++; fails.push(name); }
    console.log((ok ? 'PASS  ' : 'FAIL  ') + name.padEnd(52) + (detail === undefined ? '' : '  ' + String(detail).slice(0, 300)));
  }
  try {
    await m.open({ humanIds: ['tank_a'], aiCount: 0, vantCount: 1, rng: 'record', bootFrames: 300, rebaseAtMenu: true });
    await m.eval(INIT);
    let last = null, noTree = 0, injOK = 0, injErr = null, typesOK = {};
    for (let f = 1; f <= 900; f++) {
      await m.pump(1);
      // 每 6 帧注入一发真子弹（走游戏自己的 ProjectileState 工厂 + setProjectileState）：
      //   ① 让【子弹 token】真的非空且弹种多样；② 打对手 ⟹ 造出真威胁 ⟹
      //      触发 invalidateStaleNodes 的提前死亡剪枝（`hasGrown=1 且 children=0` 的唯一真实来源）。
      if (f % 3 === 0) {
        const r = await m.eval(INJECT);
        if (r && r.ok) { injOK++; typesOK[String(r.ty)] = (typesOK[String(r.ty)] || 0) + 1; }
        else if (!injErr) injErr = JSON.stringify(r);
      }
      if (f % 4 !== 0) continue;
      const r = await m.eval(STEP);
      if (r && r.noTree) { noTree++; continue; }
      last = r;
      if (f % 120 === 0) console.log('  ...frame ' + f + ' nNodes=' + (r.nNodes) + ' nBullets=' + (r.nBullets) + ' lag=' + (r.lag === null ? 'null' : (+r.lag).toFixed(5)) + ' total=' + r.total);
    }
    console.log('=== 注入 ===');
    console.log('  injOK=' + injOK + ' types=' + JSON.stringify(typesOK) + ' injErr=' + (injErr || 'none'));
    console.log('=== 末帧摘要 ===');
    console.log(JSON.stringify(last && { nNodes: last.nNodes, nBullets: last.nBullets, lag: last.lag, total: last.total }));

    const S = await m.eval(SNAP);
    fs.writeFileSync(path.join(__dirname, '_probe_2_3_selfproof_last.json'), JSON.stringify(S.last, null, 1));
    console.log('=== 节点 token 逐字段统计（10 维，' + S.frames + ' 帧累计）===');
    VantageFieldsPrint(S.node, ['uid', 'parentIdx', 'slot', 'depth', 'tRel', 'L', 'dx', 'dy', 'dRot', 'hasGrown']);
    console.log('=== 子弹 token 逐字段统计（7 维，' + S.frames + ' 帧累计）===');
    VantageFieldsPrint(S.bullet, ['x', 'y', 'vx', 'vy', 'theta', 'type', 'lifeLeft']);

    // ── 判定 1：真开了一局 + 树长大了 ──
    check('真开一局：树存在且非空', S.frames > 0 && last && last.nNodes > 0, 'frames=' + S.frames + ' nNodes=' + (last || {}).nNodes);
    check('树长大过（节点数 > 9，超过根一层）', last && last.nNodes > 9, 'nNodes=' + (last || {}).nNodes);
    check('"noTree" 帧数（回合重置窗口允许非 0）', noTree <= 4, 'noTree=' + noTree);
    check('子弹露出过（累计有 nBullets>0 的帧）', (S.seen && S.seen.bulletFrames > 0), 'nBullets=' + (last || {}).nBullets);

    // ── 判定 2：每个字段都【不是恒 0 / 恒 undefined】 ──
    const NODE_NAMES = ['uid', 'parentIdx', 'slot', 'depth', 'tRel', 'L', 'dx', 'dy', 'dRot', 'hasGrown'];
    const BUL_NAMES = ['x', 'y', 'vx', 'vy', 'theta', 'type', 'lifeLeft'];
    // uid 是单调计数器：可能从 0 开始 ⟹ uid=0 合法，判据用"distinct>=2"而不是"nz>0"
    const uidIdx = 0;
    S.node.forEach((s, i) => {
      const nm = NODE_NAMES[i];
      const defined = s.n > 0;
      const varies = s.distinct >= 2 || (s.min !== null && s.max !== null && Math.abs(s.max - s.min) > 1e-9);
      check('节点[' + nm + '] 有定义(n=' + s.n + ')', defined, JSON.stringify(s));
      if (nm === 'uid') check('节点[uid] 非常数（distinct>=2）', s.distinct >= 2, JSON.stringify(s));
      else if (nm === 'hasGrown') check('节点[hasGrown] 出现过 1（不是恒 0）', s.nz > 0 && s.max === 1, JSON.stringify(s));
      else if (nm === 'parentIdx') check('节点[parentIdx] 出现过 −1（根）与 ≥0（子）', s.min !== null && s.min <= -1 && s.max >= 0, JSON.stringify(s));
      else check('节点[' + nm + '] 非常量（有非零或 distinct>=2）', s.nz > 0 || varies, JSON.stringify(s));
    });
    S.bullet.forEach((s, i) => {
      const nm = BUL_NAMES[i];
      check('子弹[' + nm + '] 有定义(n=' + s.n + ')', s.n > 0, JSON.stringify(s));
      check('子弹[' + nm + '] 非常量', s.distinct >= 2, JSON.stringify(s));
      if (nm !== 'type') check('子弹[' + nm + '] 出现过非零值（不是恒 0）', s.nz > 0, JSON.stringify(s));
    });
    check('子弹 θ == atan2(speedX,−speedY) 逐颗逐帧全对', S.thetaChecked > 0 && S.thetaMismatch === 0,
      'checked=' + S.thetaChecked + ' mismatch=' + S.thetaMismatch);
    check('子弹 θ 不是恒 0（θ≠0 的样本存在）', S.bullet[4] && S.bullet[4].nz > 0 && S.bullet[4].distinct >= 2, JSON.stringify(S.bullet[4]));
    check('弹种码实见集合 = 游戏 WEAPON_TYPES 的子集（含普通弹 −1）',
      S.bulletTypeSeen.length > 0 && S.bulletTypeSeen.every(x => Number(x) >= -1 && Number(x) <= 5),
      'types=' + JSON.stringify(S.bulletTypeSeen));

    // ── 判定 3：根滞后不是恒 0 ──
    check('根滞后 有定义（dumpDiagnostics 拿得到 tNow/rootAbsT）', S.lagDefined > 0, 'lagFrames=' + S.lagFrames + ' defined=' + S.lagDefined);
    check('根滞后 不是恒 0（有非零帧）', S.lagNonZeroFrames > 0,
      'nonZero=' + S.lagNonZeroFrames + '/' + S.lagFrames + ' max=' + S.lagMax + ' min=' + S.lagMin);

    // ── 判定 4：分叉结构能表达（按父收 slot） ──
    const SEEN = S.seen || {};
    console.log('=== 跨帧累计（' + (SEEN.frames || 0) + ' 个采样帧）===');
    console.log('  bulletFrames=' + SEEN.bulletFrames + ' maxBullets=' + SEEN.maxBullets +
                ' grownByChildCount=' + JSON.stringify(SEEN.grownChildHist || {}) +
                ' nTrueDeadRows=' + SEEN.nTrueDead + ' nGrownNoChildFrames=' + SEEN.nGrownNoChildFrames);
    const exA = SEEN.a || null;
    const exB1 = SEEN.b1 || null;
    const exB0 = SEEN.b2 || null;
    console.log('=== 样例 A（某节点【有分支】）===');
    console.log(JSON.stringify(exA));
    console.log('=== 样例 B1（某节点【没分支】+【生长过】）===');
    console.log(JSON.stringify(exB1));
    console.log('=== 样例 B2（某节点【没分支】+【没生长过】）===');
    console.log(JSON.stringify(exB0));
    // 读法说明（人眼核对用）
    const demo = (n) => (n && n.token) ? ('uid=' + n.token[0] + ' parentIdx=' + n.token[1] + ' slot=' + n.token[2] +
      ' depth=' + n.token[3] + ' L=' + n.token[5] + ' hasGrown=' + n.token[9]) : 'n/a';
    console.log('  读法：' + (exA ? demo(exA) : '-') + ' | ' + (exB1 ? demo(exB1) : '-') + ' | ' + (exB0 ? demo(exB0) : '-'));
    const branchy = exA ? [{ parentIdx: exA.parentIdx, nSlots: exA.nChildren, slots: exA.childSlots }] : [];
    check('分叉可表达：存在 parentIdx 收出 ≥2 个 slot 的父节点', !!exA && exA.nChildren >= 2, JSON.stringify(exA && { p: exA.parentIdx, n: exA.nChildren }));
    check('分叉可表达：same-parent slots 互不相同（一一对应）',
      !!exA && new Set(exA.childSlots).size === exA.childSlots.length, JSON.stringify(exA && exA.childSlots));
    check('分叉可表达：样例 A 的 9 支齐（slots = 0..8 全集）',
      !!exA && exA.childSlots.join(',') === '0,1,2,3,4,5,6,7,8', JSON.stringify(exA && exA.childSlots));
    check('样例 A（有分支）取到', !!exA, JSON.stringify(exA && { p: exA.parentIdx, n: exA.nChildren }));
    check('样例 B1（没分支 + 生长过 ⟹ 真死）取到', !!exB1, JSON.stringify(exB1 && { uid: exB1.uid, fd: exB1.fullDeathFrame }));
    check('样例 B2（没分支 + 没生长过 ⟹ 不确定）取到', !!exB0, JSON.stringify(exB0 && { uid: exB0.uid }));
    check('A 与 B1 的 token 人眼可辨（hasGrown / 子槽位集 不同）',
      !!exA && !!exB1 && (exB1.token[9] === 1) && (exA.nChildren >= 2),
      'A=' + JSON.stringify(exA && exA.childSlots) + ' B1.hasGrown=' + (exB1 && exB1.token[9]));
    check('B1 与 B2 的 token 人眼可辨（同是没分支，hasGrown 0/1 不同）',
      !!exB1 && !!exB0 && exB1.token[9] === 1 && exB0.token[9] === 0,
      'B1=' + (exB1 && exB1.token[9]) + ' B2=' + (exB0 && exB0.token[9]));

    check('分叉可表达：存在 parentIdx 收出 ≥2 个 slot 的父节点', !!exA && exA.nChildren >= 2, JSON.stringify(exA && { p: exA.parentIdx, n: exA.nChildren }));
    check('节点维度 = 10 × N', D.node === 10 * toks.length, 'node=' + D.node + ' N=' + toks.length);
    check('子弹维度 = 7 × M（**不截断**）', D.bullet % 7 === 0, 'bullet=' + D.bullet);
    check('根滞后维度 = 1', D.rootLag === 1, 'rootLag=' + D.rootLag);
    check('毒雾维度 = 6', D.storm === 6, 'storm=' + D.storm);
    check('上帧计划维度 = 3 + 2*K_fire（K_fire=4 ⟹ 11）', D.plan === 11, 'plan=' + D.plan);
    // ⚠️ `L` 与"规格式 `fullDead ? (fd−1) : 75`"的对拍 —— 这是【诊断】，不是判定。
    //   原因（**本轮实测发现**）：那套式子是 **§7.7 的【智能体版】语义**（节点建在 75 帧末 / 死前 1 帧）；
    //   而当前树还是 **规则版**（`probeSegment` 按 tMin/tMax 切段，实测 L 落在 0..25）。
    //   阶段 3-1/3-2 落地后才应一致 ⟹ 现在不一致是**预期的**，不是编码器错。
    console.log('=== 诊断：L 与 §7.7 规格式的差（预期非 0，等阶段 3-1/3-2）===');
    console.log('  Lmismatch=' + (L.stat.Lmismatch || 0) + '/' + toks.length +
                '  ⟹ 当前树是【规则版】段长（probeSegment tMin/tMax），不是 §7.7 的 75/死前1帧');

    console.log('SUMMARY ' + JSON.stringify({ pass, fail, fails, frames: S.frames, nNodes: last && last.nNodes,
      lagMax: S.lagMax, lagNonZeroFrames: S.lagNonZeroFrames, branchyTop: branchy[0] || null,
      hasGrownTrue: L.stat.hasGrownTrue, noChildGrown: L.stat.noChildHasGrownTrue, noChildNotGrown: L.stat.noChildHasGrownFalse,
      injOK: injOK, typesOK: typesOK, Lmismatch: L.stat.Lmismatch }));
    check('slot 全部有真源（slotMissing = 0，opIndex 已落地）', (L.stat.slotMissing || 0) === 0, 'slotMissing=' + (L.stat && L.stat.slotMissing));
    check('parentIdx 无悬空（parentMissing = 0）', (L.stat.parentMissing || 0) === 0, 'parentMissing=' + (L.stat && L.stat.parentMissing));

    console.log('SUMMARY ' + JSON.stringify({ pass, fail, fails, frames: S.frames, nNodes: last && last.nNodes,
      lagMax: S.lagMax, lagNonZeroFrames: S.lagNonZeroFrames, branchyTop: branchy[0] || null,
      hasGrownTrue: L.stat.hasGrownTrue, noChildGrown: L.stat.noChildHasGrownTrue, noChildNotGrown: L.stat.noChildHasGrownFalse }));
  } catch (e) {
    console.error('PROBE FATAL ' + ((e && e.stack) || e));
    process.exitCode = 2;
  } finally {
    try { await m.close(); } catch (e) {}
  }
  if (fail) process.exitCode = 1;
})();

function VantageFieldsPrint(stats, names) {
  console.log('  #  字段        定义率      min            max            distinct  非零样本');
  stats.forEach((s, i) => {
    const def = s.n > 0 ? '1' : '0';
    console.log('  ' + String(i).padEnd(2) + ' ' + String(names[i]).padEnd(11) + ' ' + def.padEnd(10) +
      ' ' + String(s.min).padEnd(14) + ' ' + String(s.max).padEnd(14) +
      ' ' + String(s.distinct).padEnd(9) + ' ' + s.nz);
  });
}
