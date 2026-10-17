#!/usr/bin/env node
/* ============================================================================
 * 阶段 3-1 验收：**生长前移真的生效** + 假阳率
 *
 * 做法：真 `vantage_scoring.js` + 真 `vantage_tree_interface.js` + 真
 * `vantage_tree.js`（`VT_TREE=<path>` 可指向冻结旧树做 A/B）+ mock adapter，
 * 用真 `VT.tick(ai, dt)` 驱动。
 *
 * 信号：**复合信号** = `tree.stats.ifaceGrowAt` 增量（A 的 growAt 被 growStep
 * 消费）+ `tree.nodeCount` 增量。单看 ifaceGrowAt 会假阳（目标不是叶/expand-fail
 * 时它也会 +1 却没长出节点）⟹ 必须两量同时 +。
 *
 * 场景：
 *   S1 提交帧（`!tree.commitNode` → startCommitSlice 那条 return）：
 *      规则版不提前长（nodeCount=1，与 v181 冻结树相同）；
 *      智能体路径提前长（nodeCount>1 且 ifaceGrowAt=1）。
 *   S2 新弹 emergency 根层重选帧（`emergency && !commitNode` 那条 return，尽力覆盖）。
 *   S3 `_frozen` 帧：智能体路径也**不许长**（方针明示的例外）。
 *   S4 `worldDt<=0` 空闲帧：智能体路径也**不许长**（时间轴没走）。
 *   S5 普通帧：智能体路径**只长一次**（ifaceGrowAt 增量 = 1，不是 2）。
 *
 * 只读产品代码。
 * ============================================================================ */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const root = path.resolve(__dirname, '..', '..');
const treePath = process.env.VT_TREE ? path.resolve(process.env.VT_TREE)
  : path.join(root, 'game_core', 'js', 'vantage_tree.js');

const Constants = {
  BULLET: { RADIUS: { m: 0.25 }, OFFSET: { m: 2.5 } },
  TANK: { WIDTH: { m: 3 }, HEIGHT: { m: 4 } },
  BULLET_TURRET: { WIDTH: { m: 0.7 }, HEIGHT: { m: 1.4 }, OFFSET_X: { m: 0 }, OFFSET_Y: { m: -2 } },
  MAZE_TILE_SIZE: { m: 10 }, PIXELS_PER_METER: 20
};
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
const fakeMaze = {
  getWidth: () => 8, getHeight: () => 8, isPositionInsideMaze: () => true, getDeadEndPenalty: () => 0,
  getTiles: () => [[[1, 1, 1], [1, 0, 1]], [[1, 0, 1], [0, 0, 0]], [[1, 1, 1], [1, 0, 1]]]
};
function samplesFor(state, frames, step) {
  const out = [{ t: 0, x: state.x, y: state.y, rot: state.rot }];
  for (let k = 1; k <= frames; k++) out.push({ t: k * 0.02, x: state.x + k * step, y: state.y, rot: state.rot });
  return out;
}
let FAILS = 0, CHECKS = 0;
function check(name, cond, detail) {
  CHECKS++;
  if (!cond) FAILS++;
  console.log('  ' + (cond ? 'PASS' : 'FAIL') + '  ' + name + (detail ? '   ' + detail : ''));
}

function makeCtx() {
  const sb = { console, performance, Math, JSON, Array, Object, String, Number, isFinite, parseInt, parseFloat, Infinity, NaN, Date, Constants };
  sb.global = sb;
  sb.VantageSandbox = { fusedEnabled: () => true, OPERATIONS, clearCaches: () => {}, setFrameDtSec: () => {}, getFrameDtSec: () => 0.02 };
  const ctx = vm.createContext(sb);
  vm.runInContext(fs.readFileSync(path.join(root, 'game_core', 'js', 'vantage_scoring.js'), 'utf8'), ctx, { filename: 'scoring.js' });
  vm.runInContext(fs.readFileSync(path.join(root, 'game_core', 'js', 'vantage_tree_interface.js'), 'utf8'), ctx, { filename: 'interface.js' });
  vm.runInContext(fs.readFileSync(treePath, 'utf8'), ctx, { filename: treePath });
  sb._treePath = treePath;
  // 探针智能体：挑一个"叶子 + 非真死"的节点生长；没有就给根（首 tick 根就是叶）。
  sb.VantageTreeInterface.Agents.register({
    name: 'probe',
    isReady: function () { return true; },
    decide: function (ctx2) {
      var pick = null;
      try {
        var rows = (ctx2 && ctx2.nodes) || [];
        for (var i = 0; i < rows.length; i++) {
          var r = rows[i];
          if (r && r.nChildren === 0 && !r.invalid &&
              !(typeof r.fullDeathFrame === 'number' && r.fullDeathFrame >= 0 && r.fullDeathFrame <= 1)) {
            pick = r.id; break;
          }
        }
        if (pick === null && ctx2 && ctx2.root !== undefined && ctx2.root !== null) pick = ctx2.root;
      } catch (e0) {}
      return (pick === null) ? {} : { growAt: [pick] };
    }
  });
  return sb;
}

function makeAdapter() {
  const pose = { x: 20, y: 20, rot: 0 };
  const a = {
    constants: { FRAME_DT: 0.02, MAZE_TILE_SIZE: 10, PATH_STEP_SIZE: 0.5 },
    projectiles: [],
    pose: pose,
    rustCalls: 0, jsBatchCalls: 0, jsFusedCalls: 0, singleCalls: 0,
    getTankState: function () { return { x: pose.x, y: pose.y, rot: pose.rot }; },
    getProjectiles: function () { return a.projectiles; },
    getMaze: function () { return fakeMaze; },
    checkWall: function () { return false; },
    bulletPosAt: function () { return null; },
    getProjectilePaths: function () {
      if (!a.projectiles.length) return [];
      return [{ id: a.projectiles[0].id, path: [{ x: 100, y: 100 }, { x: 110, y: 100 }], speed: 18, x: 100, y: 100, type: -1 }];
    },
    simulateBulletTracks: function () { return []; },
    simulateTankBatchScored: function (state, ops, frames) {
      a.rustCalls++;
      return ops.map(function () {
        return { samples: samplesFor(state, frames, 0.02), perFrameScores: new Array(frames + 1).fill(2), totalScore: frames * 2, dead: false, deathFrame: -1 };
      });
    },
    simulateTankBatch: function (state, ops, frames) {
      a.jsBatchCalls++;
      return ops.map(function () {
        return { samples: samplesFor(state, frames, 0.02), perFrameScores: new Array(frames + 1).fill(2), totalScore: frames * 2, dead: false, deathFrame: -1, rustPhysics: false };
      });
    },
    simulateTankBatchJsFused: function (state, ops, frames) {
      a.jsFusedCalls++;
      return ops.map(function () {
        return { samples: samplesFor(state, frames, 0.02), dead: false, deathFrame: -1, rustPhysics: false };
      });
    },
    simulateTank: function (state, inputs, frames) {
      a.singleCalls++;
      return { samples: samplesFor({ x: state.x, y: state.y, rot: state.rot }, frames, 0.02), dead: false, deathFrame: -1 };
    }
  };
  return a;
}
function makeAi(adapter, stepCount) {
  return {
    _vantageAdapter: adapter, aiId: 'tank_a',
    gameController: {
      getMaze: () => fakeMaze, getTank: () => null,
      roundController: { model: { _ttStepCount: stepCount, _ttLastStepDt: 0.02 } }
    },
    debugTarget: null, setDebugTarget: function (x, y) { this.debugTarget = { x, y }; }, clearDebugTarget: function () { this.debugTarget = null; }
  };
}

/* ---------- S0 源码接线 ---------- */
function s0_source(treeFile) {
  console.log('--- S0 源码接线（' + path.basename(treeFile) + '）---');
  const src = fs.readFileSync(treeFile, 'utf8');
  const iEarly = src.indexOf('var _didEarlyGrow = false;');
  const iSlice = src.indexOf('if (tree._commitSlice) {', iEarly >= 0 ? iEarly : 0);
  const iEmergency = src.indexOf('if (emergency) {', iEarly >= 0 ? iEarly : 0);
  check('有 _didEarlyGrow 前移块', iEarly >= 0);
  if (iEarly >= 0) {
    check('前移块在 `if (tree._commitSlice)` 之前', iSlice > iEarly);
    check('前移块在 `if (emergency)` 之前', iEmergency > iEarly);
    check('前移块用 agentPathActive(tree) 分派', src.slice(iEarly, iEarly + 400).indexOf('agentPathActive(tree)') >= 0);
  }
  const iTail = src.lastIndexOf('if (!_didEarlyGrow) {');
  check('末尾 growStep 被 `if (!_didEarlyGrow)` 守住', iTail > 0, 'idx=' + iTail);
  check('buildCandidate 已修 NaN 隐患',
    src.indexOf(": (typeof r.totalScore === 'number' ? r.totalScore : 0);") >= 0);
}

/* ---------- 单场景跑法 ---------- */
function scenario(agentName, opt) {
  opt = opt || {};
  const sb = makeCtx();
  const VT = sb.VantageTree;
  VT.setKillfieldEnabled(false);
  VT.setGrowWithoutThreatsEnabled(true);   // 无弹也允许生长（v77 实验开关，探针专用）
  VT.reset();
  sb.VantageTreeInterface.Agents.use(agentName);
  const a = makeAdapter();
  const ai = makeAi(a, opt.step1 === undefined ? 1 : opt.step1);
  const t = (function () { VT.tick(ai, 0.02); return VT.getTree(); })();
  const rec = { VT, sb, adapter: a, ai, tree: t };
  rec.nodeCount1 = t ? t.nodeCount : -1;
  rec.ifaceGrowAt1 = (t && t.stats) ? (t.stats.ifaceGrowAt || 0) : 0;
  rec.calls1 = (t && t.stats) ? (t.stats.growStepCalls || 0) : 0;
  rec.expands1 = (t && t.stats) ? (t.stats.growExpands || 0) : 0;
  rec.after1 = { nodeCount: rec.nodeCount1, growAt: rec.ifaceGrowAt1, calls: rec.calls1, expands: rec.expands1 };
  return rec;
}

function scenarioSecondTick(agentName) {
  const r = scenario(agentName);
  // 第二 tick：默认"没新弹、世界走了一步"（stepCount 2）——普通帧
  const before = { calls: (r.tree.stats.growStepCalls || 0), expands: (r.tree.stats.growExpands || 0) };
  const ai2 = makeAi(r.adapter, 2);
  r.VT.tick(ai2, 0.02);
  r.tick2 = { before, after: { calls: (r.tree.stats.growStepCalls || 0), expands: (r.tree.stats.growExpands || 0) } };
  return r;
}

/* ---------- S1 提交帧 ---------- */
function s1_commit_frame() {
  console.log('--- S1 提交帧（`!tree.commitNode` → startCommitSlice 那条 return）---');
  const rule = scenario('rule');
  check('规则版：首 tick（提交帧）**growStep 一次都没被调**（旧行为；规则路径未碰）',
    rule.calls1 === 0, 'growStepCalls=' + rule.calls1);
  check('规则版：ifaceGrowAt=0 / growExpands=0', rule.ifaceGrowAt1 === 0 && rule.expands1 === 0,
    'growAt=' + rule.ifaceGrowAt1 + ' expands=' + rule.expands1);
  const agent = scenario('probe');
  check('智能体路径：首 tick（同一条提交帧）**growStep 被调到**（前移生效）',
    agent.calls1 === 1, 'growStepCalls=' + agent.calls1);
  check('智能体路径：真的长出节点（expandLeaf 成功）', agent.expands1 >= 1, 'growExpands=' + agent.expands1);
  check('智能体路径：A 的 growAt 被消费一次', agent.ifaceGrowAt1 === 1, 'growAt=' + agent.ifaceGrowAt1);
  check('智能体路径：首 tick 后确有 commitNode（提交路径确实走到）', !!(agent.tree && agent.tree.commitNode));
}

/* ---------- S2 新弹 emergency 帧（尽力） ---------- */
function s2_emergency_frame() {
  console.log('--- S2 新弹 emergency 根层重选帧（尽力覆盖）---');
  try {
    const r = scenario('probe');
    r.tree.commitNode = null;                         // 造 "!commitNode" 的 emergency 分支
    r.adapter.projectiles = [{ id: 'b1', x: 100, y: 100, speedX: 18, speedY: 0, speed: 18, type: -1, done: () => false }];
    const before = { calls: (r.tree.stats.growStepCalls || 0), expands: (r.tree.stats.growExpands || 0) };
    r.VT.tick(makeAi(r.adapter, 2), 0.02);
    const after = { calls: (r.tree.stats.growStepCalls || 0), expands: (r.tree.stats.growExpands || 0) };
    check('emergency 帧：growStep 被调到（+1）', after.calls - before.calls === 1,
      'dCalls=' + (after.calls - before.calls));
    check('emergency 帧：真的长出节点（expandLeaf 成功）', after.expands - before.expands >= 1,
      'dExpands=' + (after.expands - before.expands));
  } catch (e) {
    check('emergency 帧（尽力覆盖）', false, '探针夹具不支持：' + String((e && e.message) || e));
  }
}

/* ---------- S3 _frozen 帧 ---------- */
function s3_frozen_frame() {
  console.log('--- S3 `_frozen` 帧（智能体路径也不许长）---');
  const r = scenario('probe');
  r.VT.noteDeath({ getKillerPlayerId: () => 'x', getVictimPlayerId: () => 'y', getDeadlyId: () => 'p', getDeadlyType: () => -1 });
  const before = { calls: (r.tree.stats.growStepCalls || 0), expands: (r.tree.stats.growExpands || 0) };
  r.VT.tick(makeAi(r.adapter, 2), 0.02);
  const after = { calls: (r.tree.stats.growStepCalls || 0), expands: (r.tree.stats.growExpands || 0) };
  check('frozen 帧：growStep 没被调、没长', after.calls === before.calls && after.expands === before.expands,
    JSON.stringify(before) + '→' + JSON.stringify(after));
}

/* ---------- S4 空闲帧（worldDt<=0） ---------- */
function s4_idle_frame() {
  console.log('--- S4 空闲帧（worldDt<=0；时间轴没走）---');
  const r = scenario('probe');
  const before = { calls: (r.tree.stats.growStepCalls || 0), expands: (r.tree.stats.growExpands || 0) };
  r.VT.tick(makeAi(r.adapter, 1), 0.02);    // stepCount 与首 tick 相同 ⇒ worldDt=0
  const after = { calls: (r.tree.stats.growStepCalls || 0), expands: (r.tree.stats.growExpands || 0) };
  check('空闲帧：growStep 没被调、没长', after.calls === before.calls && after.expands === before.expands,
    JSON.stringify(before) + '→' + JSON.stringify(after));
}

/* ---------- S5 普通帧只长一次 ---------- */
function s5_single_grow_per_tick() {
  console.log('--- S5 普通帧：只长一次（防"提前长+末尾长"双长） ---');
  const r = scenarioSecondTick('probe');
  const dCalls = r.tick2.after.calls - r.tick2.before.calls;
  const dExpands = r.tick2.after.expands - r.tick2.before.expands;
  check('普通帧：growStep 恰好被调 1 次（不是 2 次 = 没双长）', dCalls === 1, 'dCalls=' + dCalls);
  check('普通帧：恰好长一层', dExpands === 1, 'dExpands=' + dExpands);
}

/* ---------- 假阳率 ---------- */
function falsePositiveRate() {
  console.log('--- 假阳率（AGENTS.md:136）---');
  // 不该长的三帧（rule 提交帧 / frozen / idle）里复合信号均为 0
  const rule = scenario('rule');
  const fz = scenario('probe');
  fz.VT.noteDeath({ getKillerPlayerId: () => 'x', getVictimPlayerId: () => 'y', getDeadlyId: () => 'p', getDeadlyType: () => -1 });
  const b1 = { c: (fz.tree.stats.growStepCalls || 0), e: (fz.tree.stats.growExpands || 0) };
  fz.VT.tick(makeAi(fz.adapter, 2), 0.02);
  const a1 = { c: (fz.tree.stats.growStepCalls || 0), e: (fz.tree.stats.growExpands || 0) };
  const fzIdle = scenario('probe');
  const b2 = { c: (fzIdle.tree.stats.growStepCalls || 0), e: (fzIdle.tree.stats.growExpands || 0) };
  fzIdle.VT.tick(makeAi(fzIdle.adapter, 1), 0.02);
  const a2 = { c: (fzIdle.tree.stats.growStepCalls || 0), e: (fzIdle.tree.stats.growExpands || 0) };
  // 复合信号 = "growStep 被调到 且 真的长出节点"
  const sig = (a, b) => (a.c - b.c) > 0 && (a.e - b.e) > 0;
  const sigRule = rule.calls1 > 0 && rule.expands1 > 0;
  const sigFrozen = sig(a1, b1);
  const sigIdle = sig(a2, b2);
  check('不该长的 3 帧里复合信号一次都没响（假阳=0/3）', !sigRule && !sigFrozen && !sigIdle,
    'rule=' + sigRule + ' frozen=' + sigFrozen + ' idle=' + sigIdle);
  // 该长的（agent 提交帧）响了
  const agent = scenario('probe');
  check('该长的 1 帧里复合信号响了（假阴=0）', agent.calls1 === 1 && agent.expands1 >= 1,
    'calls=' + agent.calls1 + ' expands=' + agent.expands1);
}

s0_source(treePath);
s1_commit_frame();
s2_emergency_frame();
s3_frozen_frame();
s4_idle_frame();
s5_single_grow_per_tick();
falsePositiveRate();
console.log('\n' + (FAILS ? ('3-1 GROW-FORWARD PROBE FAILED (' + FAILS + '/' + CHECKS + ')') : ('3-1 GROW-FORWARD PROBE PASSED (' + CHECKS + ' checks)')));
process.exitCode = FAILS ? 1 : 0;
