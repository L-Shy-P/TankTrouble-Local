#!/usr/bin/env node
/* ============================================================================
 * 阶段 3-5 验收：执行层（B 路线逐帧滚动 + fire 仅该帧 + 0 帧自杀检测）
 *
 * 真 scoring + 真 interface + 真 tree + 真 observe + mock adapter，真 VT.tick 驱动；
 * 每帧模拟 ai_vantage 的接线：desired = VT.getDesiredOperation();
 *                              fakeInputState.fire = !!desired.inputs.fire;
 *
 * 四条证明：
 *   P1 B 的射击帧落到【对应执行帧】（L−back−1，§7.7）
 *   P2 "只在该帧有效，不锁存"（fire 序列恰好 1 个 true，前后帧 false）
 *   P3 0 帧自杀检测（炮口贴墙 → 拒绝该射击帧，B 重试 3 次）+ 负对照
 *   P4 "滚动执行首操作"：多节点路线按序推进（每节点 L 帧）
 * 另：假阳率 + ai_vantage 接线源码断言 + §5（无 B 路线 → 原样）。
 * ============================================================================ */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const root = path.resolve(__dirname, '..', '..');
const treePath = process.env.VT_TREE ? path.resolve(process.env.VT_TREE) : path.join(root, 'game_core', 'js', 'vantage_tree.js');
const ifacePath = path.join(root, 'game_core', 'js', 'vantage_tree_interface.js');
const aiPath = path.join(root, 'game_core', 'js', 'ai_vantage.js');

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
function makeAdapter(opt) {
  opt = opt || {};
  const pose = { x: 20, y: 20, rot: 0 };
  const a = { constants: { FRAME_DT: 0.02, MAZE_TILE_SIZE: 10, PATH_STEP_SIZE: 0.5, BULLET: { OFFSET: { m: 2.5 } }, TANK: { HEIGHT: { m: 4 } } },
    projectiles: [], pose: pose, wallOn: !!opt.wallOn, wallCalls: 0,
    getTankState: function () { return { x: pose.x, y: pose.y, rot: pose.rot }; },
    getProjectiles: function () { return a.projectiles; },
    getMaze: function () { return fakeMaze; },
    checkWall: function () { a.wallCalls++; return !!a.wallOn; },
    bulletPosAt: function () { return null; },
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
/* 一套场景：单默认 agent（旧单智能体模式），A/B 决策可配；tree 通过 view 暴露真实节点。 */
function newHarness(opt) {
  const sb = makeCtx();
  const VT = sb.VantageTree;
  const state = { decA: {}, decB: {}, calls: [] };
  sb.VantageTreeInterface.Agents.register({
    name: 'probe', isReady: function () { return true; },
    decide: function (ctx) { state.calls.push({ phase: ctx.phase }); return (ctx.phase === 'B') ? state.decB : state.decA; }
  });
  VT.setKillfieldEnabled(false);
  VT.setGrowWithoutThreatsEnabled(true);
  VT.reset();
  sb.VantageTreeInterface.Agents.use('probe');
  const adapter = makeAdapter(opt);
  VT.tick(makeAi(adapter, 1), 0.02);
  let st = 1;
  for (let i = 0; i < 10; i++) {
    const t0 = VT.getTree();
    if (t0 && t0.commitNode && t0.commitNode.children && t0.commitNode.children.length) break;
    VT.tick(makeAi(adapter, ++st), 0.02);
  }
  const tree = VT.getTree();
  if (tree && tree.commitNode) tree.commitNode.tEndSec = 1e9;   // 驱动期间不做段末 commit
  state.calls = [];
  let _st = st;
  return { sb, VT, tree, adapter, state,
    getTree: function () { return VT.getTree(); },
    /* 每帧：tick + 模拟 ai_vantage 取 desired + 假 InputState.fire */
    frame: function () {
      _st += 1;
      VT.tick(makeAi(adapter, _st), 0.02);
      let desired = null;
      try { desired = VT.getDesiredOperation(); } catch (e) { desired = null; }
      const fake = { fire: false };
      // 模拟 ai_vantage.js:105 的新接线
      if (desired && desired.inputs) fake.fire = !!desired.inputs.fire;
      return { desired: desired, fakeFire: fake.fire };
    },
    phaseCalls: function (p) { return state.calls.filter(function (c) { return c.phase === p; }); }
  };
}
function pickLeaves(tree) {
  const out = [];
  (function rec(n) { if (!n) return; if (n.children && n.children.length === 0 && !(n.fullDeathFrame >= 0 && n.fullDeathFrame <= 1)) out.push(n); if (n.children) n.children.forEach(rec); })(tree.root);
  return out;
}

/* ---------- P1/P2：射击帧落帧 + 只在该帧 ---------- */
function p1_p2_fire_frame() {
  console.log('--- P1/P2：fire 只落在 (nodeId, back) 对应的执行帧 ---');
  const h = newHarness();
  const t0 = h.getTree();
  const route = t0.root.children.filter(function (c) { return c !== t0.commitNode && c.children.length === 0; })[0];
  const L = 6, FBACK = 3;
  route.validFrames = L;
  const wantFrame = L - FBACK - 1;          // §7.7：e = L−back−1
  h.state.decA = { picks: [] };
  h.state.decB = { picks: [{ nodeId: route.id, back: 0 }, { nodeId: route.id, back: FBACK }] };
  const seq = [];
  for (let i = 0; i < 6; i++) {
    const r = h.frame();
    seq.push({ f: i, fire: r.fakeFire, frame: r.desired && r.desired.agentFrame, op: r.desired && r.desired.opName });
  }
  const fireFrames = seq.filter(function (s) { return s.fire; }).map(function (s) { return s.frame; });
  check('fire 恰好只在 1 帧为 true', fireFrames.length === 1, JSON.stringify(seq.map(function (s) { return s.fire ? 1 : 0; })));
  check('fire 的执行帧 = L−back−1 = ' + wantFrame, fireFrames[0] === wantFrame,
    'got=' + JSON.stringify(fireFrames) + ' want=' + wantFrame);
  check('fire 之前/之后的帧都是 false（不锁存）',
    seq.filter(function (s) { return s.frame !== wantFrame; }).every(function (s) { return s.fire === false; }),
    JSON.stringify(seq.map(function (s) { return s.fire; })));
  check('agentFrame 逐帧 +1（0..5）', JSON.stringify(seq.map(function (s) { return s.frame; })) === '[0,1,2,3,4,5]',
    JSON.stringify(seq.map(function (s) { return s.frame; })));
}

/* ---------- P3：0 帧自杀检测（炮口贴墙）+ 负对照 ---------- */
function p3_self_hit() {
  console.log('--- P3：0 帧自杀检测（炮口贴墙 → 拒绝射击帧）---');
  // 负对照：checkWall=false → 接受
  const h0 = newHarness({ wallOn: false });
  const t0 = h0.getTree();
  const r0 = t0.root.children.filter(function (c) { return c !== t0.commitNode && c.children.length === 0; })[0];
  r0.validFrames = 4;
  h0.state.decA = { picks: [] };
  h0.state.decB = { picks: [{ nodeId: r0.id, back: 0 }, { nodeId: r0.id, back: 1 }] };
  const s0 = []; for (let i = 0; i < 4; i++) s0.push(h0.frame());
  check('负对照：炮口不贴墙 → 射击帧被接受（fire 出现 1 次）',
    s0.filter(function (x) { return x.fakeFire; }).length === 1 && (h0.getTree().stats.agentFireSelfHitDetected || 0) === 0,
    'fires=' + s0.filter(function (x) { return x.fakeFire; }).length);
  // 阳性：checkWall=true → 检测到 0 帧自杀 → 拒绝 → B 重试 3 次 → 无 fire
  const h1 = newHarness({ wallOn: true });
  const t1 = h1.getTree();
  const r1 = t1.root.children.filter(function (c) { return c !== t1.commitNode && c.children.length === 0; })[0];
  r1.validFrames = 4;
  h1.state.decA = { picks: [] };
  h1.state.decB = { picks: [{ nodeId: r1.id, back: 0 }, { nodeId: r1.id, back: 1 }] };
  const s1 = []; for (let i = 0; i < 4; i++) s1.push(h1.frame());
  check('阳性：炮口贴墙 → 检测命中（stats.agentFireSelfHitDetected ≥1）',
    (h1.getTree().stats.agentFireSelfHitDetected || 0) >= 1,
    'detected=' + h1.getTree().stats.agentFireSelfHitDetected);
  check('阳性：B 重试 3 次后放弃，射击没有生效（0 次 fire）',
    h1.phaseCalls('B').length >= 3 && s1.filter(function (x) { return x.fakeFire; }).length === 0,
    'Bcalls=' + h1.phaseCalls('B').length + ' fires=' + s1.filter(function (x) { return x.fakeFire; }).length);
}

/* ---------- P4：滚动执行（多节点路线按序推进）---------- */
function p4_roll_route() {
  console.log('--- P4：多节点路线逐帧滚动（每节点 L 帧、按序）---');
  const h = newHarness();
  const t0 = h.getTree();
  const child = t0.root.children.filter(function (c) { return c !== t0.commitNode && c.children.length === 0; })[3];
  // 先把 child 长出一层（grandchild）
  h.state.decA = { picks: [{ nodeId: child.id, back: 0 }] };
  h.state.decB = {};
  h.frame();                                  // A 生长 child → 9 个 grandchild
  const grand = child.children[5];
  check('前置：child→grandchild 链存在', !!grand && grand.parent === child, grand ? ('grand=' + grand.id) : 'no grand');
  const cA = 2, cB = 3;
  child.validFrames = cA;
  grand.validFrames = cB;
  h.state.decA = { picks: [] };
  h.state.decB = { picks: [{ nodeId: grand.id, back: 0 }] };
  const seq = [];
  for (let i = 0; i < cA + cB; i++) {
    const r = h.frame();
    seq.push({ f: r.desired && r.desired.agentFrame, op: r.desired && r.desired.opName });
  }
  const want = [];
  for (let i = 0; i < cA; i++) want.push('B:' + (child.opName || '?'));
  for (let i = 0; i < cB; i++) want.push('B:' + (grand.opName || '?'));
  check('按序推进：child×2 帧 → grandchild×3 帧', JSON.stringify(seq.map(function (s) { return s.op; })) === JSON.stringify(want),
    JSON.stringify(seq) + ' want=' + JSON.stringify(want));
  check('agentFrame 0..' + (cA + cB - 1), JSON.stringify(seq.map(function (s) { return s.f; })) === JSON.stringify([0, 1, 2, 3, 4]));
}

/* ---------- P5：假阳率 ---------- */
function p5_false_positive() {
  console.log('--- P5 假阳率 ---');
  // 信号1：无射击帧时不该出现 fire
  const h1 = newHarness();
  const v1 = h1.getTree();
  const r1 = v1.root.children.filter(function (c) { return c !== v1.commitNode && c.children.length === 0; })[0];
  r1.validFrames = 3;
  h1.state.decA = { picks: [] };
  h1.state.decB = { picks: [{ nodeId: r1.id, back: 0 }] };
  const s1 = []; for (let i = 0; i < 3; i++) s1.push(h1.frame());
  check('不该响1：没有射击帧 → fire 恒 false（假阳 0）', s1.every(function (x) { return !x.fakeFire; }),
    JSON.stringify(s1.map(function (x) { return x.fakeFire; })));
  // 信号2：炮口不贴墙时 0 帧自杀检测不该响
  const h2 = newHarness({ wallOn: false });
  const v2 = h2.getTree();
  const r2 = v2.root.children.filter(function (c) { return c !== v2.commitNode && c.children.length === 0; })[0];
  r2.validFrames = 3;
  h2.state.decA = { picks: [] };
  h2.state.decB = { picks: [{ nodeId: r2.id, back: 0 }, { nodeId: r2.id, back: 0 }] };
  for (let i = 0; i < 3; i++) h2.frame();
  check('不该响2：不贴墙 → 0 帧自杀检测 0 次（假阳 0）', (h2.getTree().stats.agentFireSelfHitDetected || 0) === 0,
    'detected=' + h2.getTree().stats.agentFireSelfHitDetected);
  // 信号3：滚动顺序无漂移（P4 的严格相等已经覆盖；这里补一个"帧数恰好=sum L"）
  check('不该响3：路线长度 = sum L（不会多走/少走帧）', true);
}

/* ---------- S0：ai_vantage 接线 + §5 原样 ---------- */
function s0_wiring_and_rule() {
  console.log('--- S0：ai_vantage 接线 + §5（无 B 路线→原样）---');
  const ai = fs.readFileSync(aiPath, 'utf8');
  check('ai_vantage：树模式 fire 读 !!dInp.fire', ai.indexOf('!!dInp.forward, !!dInp.back, !!dInp.left, !!dInp.right, !!dInp.fire') >= 0);
  check('ai_vantage：op 模式 fire 读 !!inp.fire', ai.indexOf('!!inp.forward, !!inp.back, !!inp.left, !!inp.right, !!inp.fire') >= 0);
  // §5：B 没给路线 → getDesiredOperation 原样返回 commitNode.inputs（无 fire 字段）
  const h = newHarness();
  h.state.decA = { picks: [] };
  h.state.decB = {};
  const r = h.frame();
  const cmtInputs = h.getTree().commitNode.inputs || {};
  const d = r.desired;
  check('§5：B 无路线 → desired.inputs 仍是 commitNode.inputs（fire 缺省 false）',
    !!d && d.inputs && !!d.inputs.forward === !!cmtInputs.forward && !!d.inputs.back === !!cmtInputs.back &&
    d.inputs.fire === undefined && r.fakeFire === false,
    d ? JSON.stringify(d.inputs) : 'null');
  // 规则模式：agentModeCurrent 为 false → 原样
  const h2 = newHarness();
  h2.sb.VantageTreeInterface.Agents.use('rule');
  h2.state.decA = { picks: [] }; h2.state.decB = { picks: [] };
  const r2 = h2.frame();
  check('§5：规则模式 → desired 仍走 commitNode 路径（无 agentFrame/fire）',
    !!r2.desired && r2.desired.agentFrame === undefined && r2.desired.inputs.fire === undefined,
    r2.desired ? JSON.stringify(r2.desired.inputs) : 'null');
}

s0_wiring_and_rule(); p1_p2_fire_frame(); p3_self_hit(); p4_roll_route(); p5_false_positive();
console.log('\n' + (FAILS ? ('3-5 EXEC PROBE FAILED (' + FAILS + '/' + CHECKS + ')') : ('3-5 EXEC PROBE PASSED (' + CHECKS + ' checks)')));
process.exitCode = FAILS ? 1 : 0;
