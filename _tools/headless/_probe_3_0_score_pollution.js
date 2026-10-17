#!/usr/bin/env node
/* ============================================================================
 * 阶段 3-0 反向验证：**把评分字段污染/抽掉，机械操作是否照常工作**
 *
 * 走真 `vantage_tree.js`（Node VM + 真 vantage_scoring.js + 真
 * vantage_tree_interface.js），mock adapter 只提供物理/评分通道。
 *
 * 四个对照：
 *   S1 规则版 + JS 融合确认通道**抽掉评分类字段** → 死亡写不回去（**旧耦合**，
 *      本步不动它：权威版 §5「不许为了新语义改规则版路径」）。
 *   S2 智能体路径（本帧有 A 决策）+ 同一条抽掉评分的确认通道 → 死亡照常写回
 *      （fd/status/fullDead/segmentFrames/simState 全部落地）。
 *   S3 智能体路径 + 增量 rescore 只回物理字段（`perFrameScores:null`）→
 *      更早死亡合并 + 死亡缩短 + 祖先失效照常。
 *   S4 规则版 + 同一条物理-only rescore → 节点原样（证明规则路径未被碰）。
 *   S5 智能体路径 + 评分字段全 NaN → 机械字段仍正确（NaN 只污染评分字段本身）。
 *
 * 只读产品代码；不改任何产品文件。
 * ============================================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..', '..');
const scoringPath = path.join(root, 'game_core', 'js', 'vantage_scoring.js');
// 允许用 VT_TREE=<path> 指向冻结的旧树（只读对照；默认 = 产品源码）。
const treePath = process.env.VT_TREE ? path.resolve(process.env.VT_TREE)
  : path.join(root, 'game_core', 'js', 'vantage_tree.js');
const ifacePath = path.join(root, 'game_core', 'js', 'vantage_tree_interface.js');

const Constants = {
  BULLET: { RADIUS: { m: 0.25 }, OFFSET: { m: 2.5 } },
  TANK: { WIDTH: { m: 3 }, HEIGHT: { m: 4 } },
  BULLET_TURRET: { WIDTH: { m: 0.7 }, HEIGHT: { m: 1.4 }, OFFSET_X: { m: 0 }, OFFSET_Y: { m: -2 } },
  LASER_TURRET: { ANTENNA_WIDTH: { m: 0.1 }, ANTENNA_HEIGHT: { m: 1.4 }, ANTENNA_OFFSET_X: { m: 0 }, ANTENNA_OFFSET_Y: { m: -2 }, DISH_WIDTH: { m: 2 }, DISH_HEIGHT: { m: 0.5 }, DISH_OFFSET_X: { m: 0 }, DISH_OFFSET_Y: { m: -1.85 } },
  DOUBLE_BARREL_TURRET: { WIDTH: { m: 1.6 }, HEIGHT: { m: 1.1 }, OFFSET_X: { m: 0 }, OFFSET_Y: { m: -1.75 } },
  SHOTGUN_TURRET: { WIDTH: { m: 1.4 }, HEIGHT: { m: 1.35 }, OFFSET_X: { m: 0 }, OFFSET_Y: { m: -1.95 } },
  MISSILE_TURRET: { WIDTH: { m: 0.3 }, CENTER_HEIGHT: { m: 1.4 }, SIDE_HEIGHT: { m: 0.4 }, OFFSET_X: { m: 0 }, OFFSET_Y: { m: -1.95 } },
  GATLING_GUN_TURRET: { WIDTH: { m: 1.4 }, HEIGHT: { m: 1.35 }, OFFSET_X: { m: 0 }, OFFSET_Y: { m: -1.95 } },
  MAZE_TILE_SIZE: { m: 10 }
};
const OPERATIONS = [
  { name: '静止', inputs: { forward: false, back: false, left: false, right: false } },
  { name: '前', inputs: { forward: true, back: false, left: false, right: false } }
];

function loadTree() {
  const sandbox = {
    console,
    performance: { now: () => Date.now() },
    Math, JSON, Object, Array, String, Number, isFinite, parseInt, parseFloat,
    Infinity, NaN, Date, Constants,
    VantageSandbox: { OPERATIONS, fusedEnabled: function () { return true; } }
  };
  sandbox.global = sandbox;
  const ctx = vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(scoringPath, 'utf8'), ctx, { filename: scoringPath });
  vm.runInContext(fs.readFileSync(ifacePath, 'utf8'), ctx, { filename: ifacePath });
  vm.runInContext(fs.readFileSync(treePath, 'utf8'), ctx, { filename: treePath });
  // 注册一个"总会给出决策"的探针智能体（本探针不真调 decide；只用它的名字 + 手动置
  // tree._agentDecision 来模拟"本帧 A 有决策"）。
  sandbox.VantageTreeInterface.Agents.register({
    name: 'probe', isReady: function () { return true; }, decide: function () { return null; }
  });
  sandbox._ctx = ctx;
  return sandbox;
}

function trackFar() {
  const pts = [];
  for (let i = 0; i < 100; i++) pts.push({ x: 100 + i * 0.01, y: 100, alive: true });
  return pts;
}
function trackNear() {
  const pts = [];
  for (let i = 0; i < 100; i++) pts.push({ x: 5.0, y: 8.0, alive: true });
  return pts;
}
function makeThreats() {
  return [
    { id: 'a', anchorOffset: 0, speed: 10, track: trackFar(), path: [] },
    { id: 'b', anchorOffset: 0, speed: 10, track: trackNear(), path: [] }
  ];
}

function addChild(tree, parent, id, oldDeath, pfs) {
  const n = tree.VT.createTreeNode(
    parent,
    { forward: false, back: false, left: false, right: false },
    { tank: { x: 5, y: 8, rot: 0 }, tGlobal: 0 }
  );
  n.id = id;
  n.opName = 'n' + id;
  n.plannedFrames = 12;
  n.segmentFrames = 12;
  n.status = 'alive';
  n.rolloutStartT = 0;
  n.rolloutSamples = [];
  for (let k = 0; k < 20; k++) n.rolloutSamples.push({ x: 5 + k * 0.01, y: 8, rot: 0 });
  n.perFrameScores = pfs ? pfs.slice() : null;
  n.fullDeathFrame = oldDeath;
  n.deathAuthority = 'fused';
  n.freshSig = 'a';
  n.scoreCache = {};
  n.rolloutTotal = 0;
  n.segmentScore = 0;
  n.baseExt = 0;
  n.subtreeBest = 0;
  tree.VT.attachChild(tree, parent, n);
  return n;
}

function setup(opts) {
  opts = opts || {};
  const sandbox = loadTree();
  const VT = sandbox.VantageTree;
  const tree = VT.createTree({ x: 5, y: 8, rot: 0 });
  tree.VT = VT;
  tree.commitNode = tree.root;
  tree.threats = makeThreats();
  tree._pendingThreats = [tree.threats[1]];
  tree.root.simState = { tank: { x: 5, y: 8, rot: 0 }, tGlobal: 0 };
  const A = addChild(tree, tree.root, 1, opts.aOldDeath === undefined ? 12 : opts.aOldDeath,
    opts.noPfs ? null : new Array(12).fill(opts.aPfs === undefined ? 10 : opts.aPfs));
  const B = addChild(tree, tree.root, 2, -1, new Array(12).fill(1));
  if (opts.grandchild) addChild(tree, A, 3, -1, new Array(6).fill(1));
  return { sandbox, VT, tree, A, B };
}

function makeAdapter(opts) {
  opts = opts || {};
  return {
    rescoreTankSamples: function (nodes) {
      return nodes.map(function (node) {
        const len = (opts.deathFrame !== undefined && opts.dead) ? opts.deathFrame
          : (node.previousScores ? node.previousScores.length : 12);
        let pfs = null;
        if (opts.pfs === 'zeros') pfs = new Array(len).fill(0);
        else if (opts.pfs === 'nan') pfs = new Array(len).fill(NaN);
        else if (opts.pfs === 'ones') pfs = new Array(len).fill(1);
        else if (opts.pfs === 'context') pfs = new Array(len).fill(node.previousScores ? 10 : 1);
        return {
          samples: node.samples,
          dead: !!opts.dead,
          deathFrame: opts.dead ? opts.deathFrame : -1,
          perFrameScores: pfs,
          totalScore: pfs ? pfs.reduce(function (s, v) { return s + (Number(v) || 0); }, 0) : 0,
          frameCount: pfs ? pfs.length : 0
        };
      });
    },
    simulateTankBatchJsFused: function (state, operations, durationFrames) {
      const samples = [];
      for (let k = 0; k <= durationFrames; k++) samples.push({ t: k * 0.02, x: 5, y: 8, rot: 0 });
      return [{ samples, hitWall: false, dead: true, deathFrame: 7 }];
    },
    simulateTankBatch: function () { return null; },
    simulateTank: function (state, inputs, durationFrames) {
      const samples = [];
      for (let k = 0; k <= durationFrames; k++) samples.push({ t: k * 0.02, x: 5, y: 8, rot: 0 });
      return { samples, hitWall: false, dead: false, deathFrame: -1 };
    },
    checkDeath: function () { return false; },
    constants: { FRAME_DT: 0.02 }
  };
}

let FAILS = 0;
function check(name, cond, detail) {
  if (!cond) FAILS++;
  console.log('  ' + (cond ? 'PASS' : 'FAIL') + '  ' + name + (detail ? '   ' + detail : ''));
}

// 把 JS 融合确认通道（VantageScoring.scorePaths）的评分类字段抽掉，只留物理字段。
function stripScoresFromScorePaths(sandbox) {
  const VS = sandbox.VantageScoring;
  const orig = VS.scorePaths;
  let calls = 0;
  VS.scorePaths = function (adapter, simState, ops, frames, threats, cfg) {
    calls++;
    const res = orig.call(this, adapter, simState, ops, frames, threats, cfg);
    return (res || []).map(function (r) {
      return r ? { samples: r.samples, dead: r.dead, deathFrame: r.deathFrame, hitWall: r.hitWall } : r;
    });
  };
  return function () { return calls; };
}

/* S1：规则版 + 确认通道抽掉评分 ⟹ 死亡写不回（旧耦合；规则路径原样）。 */
function s1_rule_confirm_no_scores() {
  console.log('--- S1 规则版 + JS 融合确认通道（抽掉评分）---');
  const { sandbox, VT, tree, A } = setup({ aOldDeath: -1, aPfs: 10 });
  sandbox.VantageTreeInterface.Agents.use('rule');
  const calls = stripScoresFromScorePaths(sandbox);
  VT.refreshCandidateScores(tree, makeAdapter({ pfs: 'context' }));
  check('选择仍落在 A（选路由评分字段决定，本步未动）', tree.root.next === A, 'next=' + (tree.root.next && tree.root.next.id));
  check('确认通道确实被调用（且返回无评分）', calls() > 0, 'calls=' + calls());
  check('规则版：死亡没被写回（= 旧耦合仍在，规则路径一字未改）',
    A.fullDeathFrame === -1, 'fd=' + A.fullDeathFrame);
  // 附注：confirmExecutionNodeDeath 末尾无条件写 deathAuthority（旧行为，本步未动）。
  check('规则版（附注）：authority 被无条件改成 fused（旧行为）', A.deathAuthority === 'fused', A.deathAuthority);
}

/* S2：智能体路径 + 同一条抽掉评分的确认通道 ⟹ 死亡照常写回。 */
function s2_agent_confirm_no_scores() {
  console.log('--- S2 智能体路径（本帧有 A 决策）+ 同一条确认通道 ---');
  const { sandbox, VT, tree, A } = setup({ aOldDeath: -1, aPfs: 10 });
  sandbox.VantageTreeInterface.Agents.use('probe');
  tree._agentDecision = {};            // 模拟"本帧 A 真的给了决策"
  const calls = stripScoresFromScorePaths(sandbox);
  VT.refreshCandidateScores(tree, makeAdapter({ pfs: 'context' }));
  check('确认通道被调用', calls() > 0, 'calls=' + calls());
  check('智能体路径：JS 融合 fd=7 写回（无评分也落地）', A.fullDeathFrame === 7, 'fd=' + A.fullDeathFrame);
  check('智能体路径：deathAuthority=fused', A.deathAuthority === 'fused', A.deathAuthority);
  // v183（3-2）：智能体路径的"长度"= §7.7 L = fd−1 = 6；status 仍 alive（有合法停点）；
  //   规则遗产的 segmentFrames 不再被智能体路径写（保持 12）。
  check('智能体路径：fullDead 落位 + status=alive（L=6 仍有合法停点）',
    A.fullDead === true && A.status === 'alive', 'status=' + A.status + ' fullDead=' + A.fullDead);
  check('智能体路径：L=validFrames=fd−1=6（不再写 segmentFrames，seg 保持 12）',
    A.validFrames === 6 && A.segmentFrames === 12, 'L=' + A.validFrames + ' seg=' + A.segmentFrames);
  check('智能体路径：simState.tGlobal 按 L 落位（6 帧）', Math.abs(A.simState.tGlobal - 6 * 0.02) < 1e-12,
    'tGlobal=' + A.simState.tGlobal);
}

/* S3b：智能体路径 + **无旧评分**（full rescore 组）+ 物理-only ⟹ 机械仍落地。 */
function s3b_agent_rescore_physics_only_no_prev_scores() {
  console.log('--- S3b 智能体路径 + 物理-only（节点无旧评分 / full-rescore 组）---');
  const { sandbox, VT, tree, A } = setup({ aOldDeath: -1, noPfs: true, grandchild: true });
  sandbox.VantageTreeInterface.Agents.use('probe');
  tree._agentDecision = {};
  const adapter = makeAdapter({ dead: true, deathFrame: 5, pfs: null });
  VT.ensureLayerFresh(tree, adapter, tree.root);
  check('无旧评分（full-rescore 组）也能写回更早死亡 fd=5', A.fullDeathFrame === 5, 'fd=' + A.fullDeathFrame);
  check('L=validFrames=4 / status=alive / seg 保持 12',
    A.validFrames === 4 && A.status === 'alive' && A.segmentFrames === 12,
    'L=' + A.validFrames + ' seg=' + A.segmentFrames + ' status=' + A.status);
  check('后代被失效摘除', A.children.length === 0, 'children=' + A.children.length);
}

/* S4b：规则版 + 物理-only + **无旧评分** ⟹ 节点原样（旧耦合，规则路径未碰）。 */
function s4b_rule_rescore_physics_only_no_prev_scores() {
  console.log('--- S4b 规则版 + 物理-only（节点无旧评分）---');
  const { sandbox, VT, tree, A } = setup({ aOldDeath: -1, noPfs: true, grandchild: true });
  sandbox.VantageTreeInterface.Agents.use('rule');
  const adapter = makeAdapter({ dead: true, deathFrame: 5, pfs: null });
  VT.ensureLayerFresh(tree, adapter, tree.root);
  check('规则版：缺评分 → 死亡写不回（fd 原样 -1）', A.fullDeathFrame === -1, 'fd=' + A.fullDeathFrame);
  check('规则版：segmentFrames 原样 12', A.segmentFrames === 12, 'seg=' + A.segmentFrames);
  check('规则版：后代原样保留', A.children.length === 1, 'children=' + A.children.length);
}

/* S6：评分在场时，规则版与智能体路径的写回结果必须**逐值一致**（分支中性）。 */
function s6_parity_with_scores() {
  console.log('--- S6 评分在场：规则版 vs 智能体路径（分支中性）---');
  function run(agent) {
    const { sandbox, VT, tree, A } = setup({ aOldDeath: 12, aPfs: 10, grandchild: true });
    sandbox.VantageTreeInterface.Agents.use(agent);
    if (agent !== 'rule') tree._agentDecision = {};
    VT.ensureLayerFresh(tree, makeAdapter({ dead: true, deathFrame: 5, pfs: 'zeros' }), tree.root);
    return {
      fd: A.fullDeathFrame, seg: A.segmentFrames, validFrames: A.validFrames, status: A.status, fullDead: A.fullDead,
      simT: A.simState.tGlobal, children: A.children.length,
      segScore: A.segmentScore, total: A.rolloutTotal, best: A.subtreeBest
    };
  }
  const rule = run('rule');
  const agent = run('probe');
  // v183（3-2）：机械口径**有意分家**（规则版 safeFrames 口径不变；智能体路径 §7.7 L 口径）。
  const ruleOk = rule.fd === 5 && rule.seg === 2 && rule.status === 'dead' && rule.simT === 0.04;
  const agentOk = agent.fd === 5 && agent.validFrames === 4 && agent.seg === 12 && agent.status === 'alive' && agent.simT === 0.08;
  check('规则版写回保持旧口径（seg=2/status=dead，§5 未碰）', ruleOk, JSON.stringify(rule));
  check('智能体路径写回按 §7.7 L 口径（L=4/status=alive/seg 不写）', agentOk, JSON.stringify(agent));
  check('评分字段（segScore/total/best）两路径逐值一致', rule.segScore === agent.segScore &&
    rule.total === agent.total && rule.best === agent.best,
    'rule=' + rule.segScore + '/' + rule.total + '/' + rule.best + ' agent=' + agent.segScore + '/' + agent.total + '/' + agent.best);
}

/* S3：智能体路径 + 增量 rescore 只回物理字段 ⟹ 更早死亡合并 + 失效照常。 */
function s3_agent_rescore_physics_only() {
  console.log('--- S3 智能体路径 + 增量 rescore 物理-only（更早死亡）---');
  const { sandbox, VT, tree, A } = setup({ aOldDeath: 12, aPfs: 10, grandchild: true });
  sandbox.VantageTreeInterface.Agents.use('probe');
  tree._agentDecision = {};
  check('前置：A 有一个后代', A.children.length === 1, 'children=' + A.children.length);
  const adapter = makeAdapter({ dead: true, deathFrame: 5, pfs: null });
  VT.ensureLayerFresh(tree, adapter, tree.root);
  check('物理合并：更早死亡 5 落地（perFrameScores=null 也工作）', A.fullDeathFrame === 5, 'fd=' + A.fullDeathFrame);
  check('物理合并：L=validFrames=fd−1=4（seg 保持 12）',
    A.validFrames === 4 && A.segmentFrames === 12, 'L=' + A.validFrames + ' seg=' + A.segmentFrames);
  check('物理合并：fullDead=true / status=alive（L≥1）', A.status === 'alive' && A.fullDead === true,
    'status=' + A.status + ' fullDead=' + A.fullDead);
  check('物理合并：更早死亡触发祖先失效（后代已摘除）', A.children.length === 0, 'children=' + A.children.length);
  check('物理合并：deathAuthority 标 rust-candidate', A.deathAuthority === 'rust-candidate', A.deathAuthority);
  check('评分字段没有被伪造（仍是旧数组/旧值）', Array.isArray(A.perFrameScores) && A.perFrameScores.length === 12,
    'pfs=' + (A.perFrameScores ? A.perFrameScores.length : null));
}

/* S4：规则版 + 物理-only rescore，但节点**自己还留着旧评分** ⟹ 合并退回旧评分，
 *     规则版照常（旧的兜底通道；不是失败，是"评分通道还在"的正常行为）。 */
function s4_rule_rescore_physics_only() {
  console.log('--- S4 规则版 + 物理-only rescore（节点仍留旧评分）---');
  const { sandbox, VT, tree, A } = setup({ aOldDeath: 12, aPfs: 10, grandchild: true });
  sandbox.VantageTreeInterface.Agents.use('rule');   // 且不置 _agentDecision
  const adapter = makeAdapter({ dead: true, deathFrame: 5, pfs: null });
  VT.ensureLayerFresh(tree, adapter, tree.root);
  check('规则版：旧评分尚在 → 合并退回 c.perFrameScores，照常写回 fd=5',
    A.fullDeathFrame === 5, 'fd=' + A.fullDeathFrame);
  check('规则版：segmentFrames=2 / 后代失效', A.segmentFrames === 2 && A.children.length === 0,
    'seg=' + A.segmentFrames + ' children=' + A.children.length);
}

/* S5：智能体路径 + 评分全 NaN ⟹ 机械字段仍正确。 */
function s5_agent_nan_scores() {
  console.log('--- S5 智能体路径 + 评分字段全 NaN ---');
  const { sandbox, VT, tree, A } = setup({ aOldDeath: 12, aPfs: 10 });
  sandbox.VantageTreeInterface.Agents.use('probe');
  tree._agentDecision = {};
  const adapter = makeAdapter({ dead: true, deathFrame: 5, pfs: 'nan' });
  let threw = null;
  try { VT.ensureLayerFresh(tree, adapter, tree.root); } catch (e) { threw = e; }
  check('没有抛异常', threw === null, threw ? String(threw && threw.message || threw) : '');
  check('机械字段仍正确：fd=5 / L=4 / status=alive（NaN 不污染机械）',
    A.fullDeathFrame === 5 && A.validFrames === 4 && A.status === 'alive' && !Number.isNaN(A.simState.tGlobal),
    'fd=' + A.fullDeathFrame + ' L=' + A.validFrames + ' status=' + A.status + ' tG=' + A.simState.tGlobal);
  const pfsNaN = Array.isArray(A.perFrameScores) && A.perFrameScores.some(function (x) { return Number.isNaN(Number(x)); });
  check('评分类字段确实被 NaN 污染（正是"污染输入"本身）', pfsNaN,
    'pfs=' + JSON.stringify(A.perFrameScores));
}

/* 源码级接线断言：新通道存在 + 三个调用点都走统一入口 + 规则版分支保留。 */
function s0_source_wiring() {
  console.log('--- S0 源码接线断言 ---');
  const src = fs.readFileSync(treePath, 'utf8');
  check('define applyRolloutPhysics', src.indexOf('function applyRolloutPhysics(tree, node, r)') >= 0);
  check('define agentPathActive', src.indexOf('function agentPathActive(tree)') >= 0);
  check('define applyRolloutResult', src.indexOf('function applyRolloutResult(tree, node, r)') >= 0);
  check('三个调用点都改走 applyRolloutResult', (src.split('applyRolloutResult(tree,').length - 1) >= 3,
    'n=' + (src.split('applyRolloutResult(tree,').length - 1));
  check('规则版分支仍原样调 applyRolloutScore',
    src.indexOf('return applyRolloutScore(tree, node, r);') >= 0);
  check('applyRolloutScore 的评分守卫仍在（规则版不受影响）',
    src.indexOf("if (!node || !r || !r.perFrameScores) return false;") >= 0);
  check('规则版 mergeIncrementalRescoreDeath 保持两参（守卫可抽出来跑）',
    src.indexOf('function mergeIncrementalRescoreDeath(c, r)') >= 0);
  check('新增纯物理合并 mergePhysicalDeathOnly（智能体路径兜底）',
    src.indexOf('function mergePhysicalDeathOnly(c, r)') >= 0);
  // v183（3-2）：智能体路径的机械字段改用独立 validFrames（§7.7 L），不再碰 segmentFrames
  check('新增 applyRolloutScoreFields（只写评分字段，不回写机械字段）',
    src.indexOf('function applyRolloutScoreFields(node, r)') >= 0);
  (function () {
    var _iA = src.indexOf('function applyRolloutPhysics(');
    var _iB = src.indexOf('function applyRolloutResult(', _iA);
    var _ap = (_iA >= 0 && _iB > _iA) ? src.slice(_iA, _iB) : '';
    check('applyRolloutPhysics 写 validFrames（函数体内不写 segmentFrames）',
      _ap.indexOf('node.validFrames = L;') >= 0 && _ap.indexOf('node.segmentFrames =') < 0);
  })();
}

s0_source_wiring();
s1_rule_confirm_no_scores();
s2_agent_confirm_no_scores();
s3_agent_rescore_physics_only();
s3b_agent_rescore_physics_only_no_prev_scores();
s4_rule_rescore_physics_only();
s4b_rule_rescore_physics_only_no_prev_scores();
s6_parity_with_scores();
s5_agent_nan_scores();
console.log('\n' + (FAILS ? ('3-0 SCORE-POLLUTION PROBE FAILED (' + FAILS + ')') : '3-0 SCORE-POLLUTION PROBE PASSED'));
process.exitCode = FAILS ? 1 : 0;
