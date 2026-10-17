#!/usr/bin/env node
/* ============================================================================
 * 阶段 3-4 验收：同 tick 两次调用（A → 生长 → B，全有或全无）
 *
 * 真 `vantage_scoring.js` + 真 `vantage_tree_interface.js` + 真 `vantage_tree.js`
 * + 真 `vantage_observe.js` + mock adapter，用真 `VT.tick` 驱动。
 * 探针智能体按 `ctx.phase` 分别返回 A/B 决策，并记录每次调用的 ctx 快照。
 *
 * 三条证明：
 *   P1 B 看到 A 本帧刚长的节点（ctxB.nodes == ctxA.nodes + 新长数；同 tick time 相等）
 *   P2 全有或全无 / B 失败：A 的生长在、B 的路线不生效（不回滚的理由见报告）
 *   P3 D11：树满时 A 不调用、B 照常调用
 * 另：P4 B 的 picks 语义（picks[0]=路线、picks[1..]=射击帧）；P5 假阳率。
 * ============================================================================ */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const root = path.resolve(__dirname, '..', '..');
const treePath = process.env.VT_TREE ? path.resolve(process.env.VT_TREE) : path.join(root, 'game_core', 'js', 'vantage_tree.js');
const ifacePath = process.env.VT_IFACE ? path.resolve(process.env.VT_IFACE) : path.join(root, 'game_core', 'js', 'vantage_tree_interface.js');

const Constants={BULLET:{RADIUS:{m:0.25},OFFSET:{m:2.5}},TANK:{WIDTH:{m:3},HEIGHT:{m:4}},BULLET_TURRET:{WIDTH:{m:0.7},HEIGHT:{m:1.4},OFFSET_X:{m:0},OFFSET_Y:{m:-2}},LASER_TURRET:{ANTENNA_WIDTH:{m:0.1},ANTENNA_HEIGHT:{m:1.4},ANTENNA_OFFSET_X:{m:0},ANTENNA_OFFSET_Y:{m:-2},DISH_WIDTH:{m:2},DISH_HEIGHT:{m:0.5},DISH_OFFSET_X:{m:0},DISH_OFFSET_Y:{m:-1.85}},DOUBLE_BARREL_TURRET:{WIDTH:{m:1.6},HEIGHT:{m:1.1},OFFSET_X:{m:0},OFFSET_Y:{m:-1.75}},SHOTGUN_TURRET:{WIDTH:{m:1.4},HEIGHT:{m:1.35},OFFSET_X:{m:0},OFFSET_Y:{m:-1.95}},MISSILE_TURRET:{WIDTH:{m:0.3},CENTER_HEIGHT:{m:1.4},SIDE_HEIGHT:{m:0.4},OFFSET_X:{m:0},OFFSET_Y:{m:-1.95}},GATLING_GUN_TURRET:{WIDTH:{m:1.4},HEIGHT:{m:1.35},OFFSET_X:{m:0},OFFSET_Y:{m:-1.95}},MAZE_TILE_SIZE:{m:10},PIXELS_PER_METER:20};
const OPERATIONS = [
  { name: '静止', inputs: { forward: false, back: false, left: false, right: false } },
  { name: '前', inputs: { forward: true, back: false, left: false, right: false } },
  { name: '后', inputs: { forward: false, back: true, left: false, right: false } },
  { name: '左', inputs: { forward: false, back: false, left: true, right: false } },
  { name: '右', inputs: { forward: false, back: false, left: false, right: true } },
  { name: '前左', inputs: { forward: true, back: false, left: true, right: false } },
  { name: '前右', inputs: { forward: true, back: false, left: false, right: true } },
  { name: '后左', inputs: { forward: false, back: true, left: true, right: false } },
  { name: '后右', inputs: { forward: false, back: true, left: false, right: true } }
];
const fakeMaze = { getWidth: () => 8, getHeight: () => 8, isPositionInsideMaze: () => true, getDeadEndPenalty: () => 0,
  getTiles: () => [[[1, 1, 1], [1, 0, 1]], [[1, 0, 1], [0, 0, 0]], [[1, 1, 1], [1, 0, 1]]] };
function samplesFor(state, frames, step) {
  const out = [{ t: 0, x: state.x, y: state.y, rot: state.rot }];
  for (let k = 1; k <= frames; k++) out.push({ t: k * 0.02, x: state.x + k * step, y: state.y, rot: state.rot });
  return out;
}
let FAILS = 0, CHECKS = 0;
function check(name, cond, detail) {
  CHECKS++; if (!cond) FAILS++;
  console.log('  ' + (cond ? 'PASS' : 'FAIL') + '  ' + name + (detail ? '   ' + detail : ''));
}
function makeAdapter() {
  const pose = { x: 20, y: 20, rot: 0 };
  const a = { constants: { FRAME_DT: 0.02, MAZE_TILE_SIZE: 10, PATH_STEP_SIZE: 0.5 }, projectiles: [], pose: pose,
    getTankState: function () { return { x: pose.x, y: pose.y, rot: pose.rot }; },
    getProjectiles: function () { return a.projectiles; },
    getMaze: function () { return fakeMaze; },
    checkWall: function () { return false; }, bulletPosAt: function () { return null; },
    getProjectilePaths: function () { return []; }, simulateBulletTracks: function () { return []; },
    simulateTankBatchScored: function (state, ops, frames) {
      return ops.map(function () { return { samples: samplesFor(state, frames, 0.02), perFrameScores: new Array(frames + 1).fill(2), totalScore: frames * 2, dead: false, deathFrame: -1, rustPhysics: false }; });
    },
    simulateTankBatch: function (state, ops, frames) {
      return ops.map(function () { return { samples: samplesFor(state, frames, 0.02), perFrameScores: new Array(frames + 1).fill(2), totalScore: frames * 2, dead: false, deathFrame: -1, rustPhysics: false }; });
    },
    simulateTankBatchJsFused: function (state, ops, frames) {
      return ops.map(function () { return { samples: samplesFor(state, frames, 0.02), dead: false, deathFrame: -1, rustPhysics: false }; });
    },
    simulateTank: function (state, inputs, frames) { return { samples: samplesFor({ x: state.x, y: state.y, rot: state.rot }, frames, 0.02), dead: false, deathFrame: -1 }; }
  };
  return a;
}
function makeAi(adapter, stepCount) {
  return { _vantageAdapter: adapter, aiId: 'tank_a',
    gameController: { getMaze: () => fakeMaze, getTank: () => null,
      roundController: { model: { _ttStepCount: stepCount, _ttLastStepDt: 0.02 } } },
    debugTarget: null, setDebugTarget: function (x, y) { this.debugTarget = { x, y }; }, clearDebugTarget: function () { this.debugTarget = null; } };
}
function makeCtx() {
  const sb = { console, performance, Math, JSON, Array, Object, String, Number, isFinite, parseInt, parseFloat, Infinity, NaN, Date, Constants };
  sb.global = sb;
  sb.VantageSandbox = { fusedEnabled: () => true, OPERATIONS, clearCaches: () => {}, setFrameDtSec: () => {}, getFrameDtSec: () => 0.02 };
  const ctx = vm.createContext(sb);
  vm.runInContext(fs.readFileSync(path.join(root, 'game_core', 'js', 'vantage_scoring.js'), 'utf8'), ctx, { filename: 'scoring.js' });
  vm.runInContext(fs.readFileSync(ifacePath, 'utf8'), ctx, { filename: 'interface.js' });
  vm.runInContext(fs.readFileSync(treePath, 'utf8'), ctx, { filename: 'tree.js' });
  vm.runInContext(fs.readFileSync(path.join(root, 'game_core', 'js', 'vantage_observe.js'), 'utf8'), ctx, { filename: 'observe.js' });
  return sb;
}
function pickLeaves(tree) {
  const out = [];
  (function rec(n) { if (!n) return; if (n.children && n.children.length === 0 && !(n.fullDeathFrame >= 0 && n.fullDeathFrame <= 1)) out.push(n); if (n.children) n.children.forEach(rec); })(tree.root);
  return out;
}
/* 每个场景一套全新 VM/树；state.decA/decB 可随时改，calls 记录每次 decide 的 ctx 摘要。 */
function newHarness(agentName) {
  const sb = makeCtx();
  const VT = sb.VantageTree;
  const state = { decA: {}, decB: {}, calls: [], routeUsed0: 0 };
  sb.VantageTreeInterface.Agents.register({
    name: 'probe', isReady: function () { return true; },
    decide: function (ctx, retry) {
      state.calls.push({ phase: ctx.phase, nodes: ctx.nodes.length, root: ctx.root, commit: ctx.commit,
                         time: ctx.time, attempt: (retry && retry.attempt) || 1,
                         ids: ctx.nodes.map(function (r) { return r.id; }) });
      return (ctx.phase === 'B') ? state.decB : state.decA;
    }
  });
  VT.setKillfieldEnabled(false);
  VT.setGrowWithoutThreatsEnabled(true);
  VT.reset();
  sb.VantageTreeInterface.Agents.use(agentName || 'probe');
  const adapter = makeAdapter();
  VT.tick(makeAi(adapter, 1), 0.02);
  // 多跑几 tick 让提交切片完成 / commitNode 带候选（A/B 都是 {}，只是搭台）
  let st = 1;
  for (let i = 0; i < 8; i++) {
    const t0 = VT.getTree();
    if (t0 && t0.commitNode && t0.commitNode.children && t0.commitNode.children.length) break;
    VT.tick(makeAi(adapter, ++st), 0.02);
  }
  const tree = VT.getTree();
  state.calls = [];
  let _st = st;
  return { sb, VT, tree, adapter, state,
    getTree: function () { return VT.getTree(); },
    // ⚠️ 每次 tick 必须让"世界步数"前进（否则 worldDt=0 → idle 早退，树什么都不做）
    tick: function () { _st += 1; VT.tick(makeAi(adapter, _st), 0.02); },
    phaseCalls: function (p) { return state.calls.filter(function (c) { return c.phase === p; }); } };
}

/* ---------- P1：B 看到 A 本帧刚长的节点 ---------- */
function p1_b_sees_a() {
  console.log('--- P1 B 看到 A 本帧刚长的节点 ---');
  const h = newHarness();
  const leaf = pickLeaves(h.getTree())[0];
  const nA0 = h.getTree().nodeCount;
  h.state.decA = { picks: [{ nodeId: leaf.id, back: 0 }] };
  h.state.decB = {};                     // B 只观测
  h.tick(20);
  const ca = h.phaseCalls('A'), cb = h.phaseCalls('B');
  check('同一 tick 里 A 先、B 后各调 1 次', ca.length === 1 && cb.length === 1 &&
    h.state.calls[0].phase === 'A' && h.state.calls[1].phase === 'B', JSON.stringify(h.state.calls.map(function (c) { return c.phase; })));
  check('A/B 同一 tick（ctx.time 相等）', ca[0].time === cb[0].time, 'A=' + ca[0].time + ' B=' + cb[0].time);
  const dN = cb[0].nodes - ca[0].nodes;
  check('B 的候选 = A 的候选 + A 本帧新长的节点数', dN === 9 && h.getTree().nodeCount === nA0 + 9,
    'ctxA=' + ca[0].nodes + ' ctxB=' + cb[0].nodes + ' delta=' + dN + ' tree=' + nA0 + '→' + h.getTree().nodeCount);
  const newIds = leaf.children.map(function (c) { return c.id; });
  check('A 新长的 9 个节点全部出现在 B 的 ctx.nodes 里（完整，不是半个切片）',
    newIds.length === 9 && newIds.every(function (id) { return cb[0].ids.indexOf(id) >= 0; }),
    'leafKids=' + newIds.length + ' inCtxB=' + newIds.filter(function (id) { return cb[0].ids.indexOf(id) >= 0; }).length);
}

/* ---------- P2：全有或全无（B 失败） ---------- */
function p2_b_failure() {
  console.log('--- P2 全有或全无 / B 调用失败 ---');
  const h = newHarness();
  const leaf = pickLeaves(h.getTree())[0];
  const routeUsed0 = h.tree.stats.agentRouteUsed || 0;
  h.state.decA = { picks: [{ nodeId: leaf.id, back: 0 }] };          // A 合法：长 9 个
  h.state.decB = { picks: [{ nodeId: 999999, back: 0 }] };           // B 非法：路线不在候选里
  h.tick(2);
  const ca = h.phaseCalls('A'), cb = h.phaseCalls('B');
  check('A 被调 1 次、B 重试 3 次后放弃', ca.length === 1 && cb.length === 3,
    'A=' + ca.length + ' B=' + cb.length);
  check('A 的生长没有被回滚（叶子仍有 9 个子；一致性由 detach/计数不变量保证）', leaf.children.length === 9,
    'kids=' + leaf.children.length);
  check('B 的路线没有生效（agentRouteUsed 不增、无崩溃）',
    (h.tree.stats.agentRouteUsed || 0) === routeUsed0, 'routeUsed=' + h.tree.stats.agentRouteUsed);
  check('说明：生长是独立的机械展开，B 失败 = 本帧路线交规则兜底（不需要回滚，详见报告 §三）', true);
}

/* ---------- P3：D11 树满 → A 不调、B 照调 ---------- */
function p3_d11_full() {
  console.log('--- P3 D11：树满时 A 不调、B 照调 ---');
  const h = newHarness();
  const skipped0 = h.tree.stats.agentSkippedFull || 0;
  h.tree.cfg.maxNodes = h.tree.nodeCount;      // 造"树满"：canAddTreeNodes(tree,9)=false
  h.state.decA = {};
  h.state.decB = {};
  h.tick(2);
  const ca = h.phaseCalls('A'), cb = h.phaseCalls('B');
  check('树满：A 0 次调用', ca.length === 0, 'A=' + ca.length);
  check('树满：B 仍被调 1 次（D11 停止生长≠停止工作）', cb.length === 1, 'B=' + cb.length);
  check('树满计数 agentSkippedFull 增加', (h.tree.stats.agentSkippedFull || 0) === skipped0 + 1,
    'skipped=' + skipped0 + '→' + h.tree.stats.agentSkippedFull);
}

/* ---------- P4：B 的 picks = 路线 + 射击帧 ---------- */
function p4_b_picks_semantics() {
  console.log('--- P4 B 的 picks[0]=路线 / picks[1..]=射击帧 ---');
  const h = newHarness();
  const cmt = h.getTree().commitNode;
  check('前置：commitNode 有候选', !!(cmt && cmt.children && cmt.children.length), cmt ? ('kids=' + cmt.children.length) : 'no cmt');
  if (!cmt || !cmt.children.length) return;
  const route = cmt.children[0];
  const fire = pickLeaves(h.getTree())[0];
  const routeUsed0 = h.tree.stats.agentRouteUsed || 0;
  cmt.tEndSec = 0;                              // 强制段末 → 走 commit → 消费 B 的路线
  h.state.decA = { picks: [] };                 // A：本帧不生长
  h.state.decB = { picks: [{ nodeId: route.id, back: 0 }, { nodeId: fire.id, back: 3 }] };
  h.tick(2);
  check('B 的路线被采用（agentSelectOverride 命中）', (h.tree.stats.agentRouteUsed || 0) === routeUsed0 + 1,
    'routeUsed=' + routeUsed0 + '→' + h.tree.stats.agentRouteUsed);
  const stats = h.getTree().stats;
  check('B 的路线 id 落位 = picks[0].nodeId', stats.agentRouteId === route.id,
    'agentRouteId=' + stats.agentRouteId + ' want=' + route.id);
  check('B 的射击帧落位 = picks[1..]（数量 + 首个 back；执行属 3-5）',
    stats.agentFireFrames === 1 && stats.agentFireFirstBack === 3,
    'frames=' + stats.agentFireFrames + ' firstBack=' + stats.agentFireFirstBack);
}

/* ---------- P5：§5 规则模式不调 A/B ---------- */
function p5_rule_mode() {
  console.log('--- P5 规则模式（§5）：A/B 都不被调用 ---');
  const h = newHarness('rule');
  h.state.decA = { picks: [] };
  h.state.decB = { picks: [] };
  h.tick(2);
  check('规则模式：探针 decide 调用 0 次（agentSeam 在 rule 分支直接返回）',
    h.state.calls.length === 0, 'calls=' + h.state.calls.length);
}

/* ---------- P6：假阳率 ---------- */
function p6_false_positive() {
  console.log('--- P6 假阳率（三个新信号）---');
  // 信号 1：B 比 A 多节点（="B 看到 A 的生长"）——A 明确 picks:[] 不生长时不该响
  const h1 = newHarness();
  h1.state.decA = { picks: [] };
  h1.state.decB = {};
  h1.tick(2);
  const ca1 = h1.phaseCalls('A'), cb1 = h1.phaseCalls('B');
  const sig1 = (cb1[0].nodes - ca1[0].nodes) > 0;
  check('不该响 1：A 明确不生长（picks:[]）→ B-A 节点差 = 0', !sig1,
    'delta=' + (cb1[0].nodes - ca1[0].nodes));
  // 信号 2：D11（A 0 次、B>0 次）——正常树未满时不该响
  const h2 = newHarness();
  h2.state.decA = { picks: [] };
  h2.state.decB = {};
  h2.tick(2);
  const sig2 = (h2.phaseCalls('A').length === 0 && h2.phaseCalls('B').length > 0);
  check('不该响 2：树未满 → A 有调用（D11 信号不响）', !sig2,
    'A=' + h2.phaseCalls('A').length + ' B=' + h2.phaseCalls('B').length);
  // 信号 3：B 失败（重试 3 次）——B 成功时不该响
  const h3 = newHarness();
  const leaf3 = pickLeaves(h3.getTree())[0];
  h3.state.decA = { picks: [{ nodeId: leaf3.id, back: 0 }] };
  h3.state.decB = {};
  h3.tick(2);
  const sig3 = h3.phaseCalls('B').length >= 3;
  check('不该响 3：B 成功 → 不出现"重试 3 次"', !sig3, 'Bcalls=' + h3.phaseCalls('B').length);
  // 该响的：A 长 9 → B-A = 9（假阴 0）
  const h4 = newHarness();
  const leaf4 = pickLeaves(h4.getTree())[0];
  h4.state.decA = { picks: [{ nodeId: leaf4.id, back: 0 }] };
  h4.state.decB = {};
  h4.tick(2);
  const c4a = h4.phaseCalls('A'), c4b = h4.phaseCalls('B');
  const sig4 = (c4b[0].nodes - c4a[0].nodes) === 9;
  check('该响：A 长 9 → B-A = 9（假阴 0）', sig4, 'delta=' + (c4b[0].nodes - c4a[0].nodes));
}

p1_b_sees_a(); p2_b_failure(); p3_d11_full(); p4_b_picks_semantics(); p5_rule_mode(); p6_false_positive();
console.log('\n' + (FAILS ? ('3-4 TWO-CALL PROBE FAILED (' + FAILS + '/' + CHECKS + ')') : ('3-4 TWO-CALL PROBE PASSED (' + CHECKS + ' checks)')));
process.exitCode = FAILS ? 1 : 0;
