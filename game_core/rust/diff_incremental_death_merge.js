#!/usr/bin/env node
// Regression test for v77 incremental death merge + JS fused confirmation on
// the execution route.
//
// Loads the REAL vantage_scoring.js and vantage_tree.js in a Node VM with a
// minimal VantageSandbox stub and a mock adapter whose
// `rescoreTankSamples` behaves like the Rust path (candidate-only death
// frames, tagged by the tree as rust-candidate) and whose
// `simulateTankBatchJsFused` behaves like the JS fused world.
//
// Scenarios:
//   A. old-bullet death is carried when the new-bullet candidate says alive
//   B. new-bullet death moves the merged death earlier
//   C. the child selected as next has its Rust-candidate death confirmed by
//      the JS fused world before it is written onto the execution route.

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const scoringPath = path.join(root, 'js', 'vantage_scoring.js');
const treePath = path.join(root, 'js', 'vantage_tree.js');

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
    Infinity, NaN, Date,
    Constants,
    VantageSandbox: {
      OPERATIONS,
      fusedEnabled: function () { return true; }
    }
  };
  sandbox.global = sandbox;
  const ctx = vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(scoringPath, 'utf8'), ctx, { filename: scoringPath });
  vm.runInContext(fs.readFileSync(treePath, 'utf8'), ctx, { filename: treePath });
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

function makeChild(tree, parent, id, oldDeath, pfs) {
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
  for (let k = 0; k < 20; k++) n.rolloutSamples.push({ x: 5, y: 8, rot: 0 });
  n.perFrameScores = pfs.slice();
  n.fullDeathFrame = oldDeath;
  n.deathAuthority = 'fused';
  n.freshSig = 'a';
  n.scoreCache = {};
  n.rolloutTotal = 0;
  n.segmentScore = 0;
  n.baseExt = 0;
  n.subtreeBest = 0;
  tree.VT.attachChild(tree, tree.root, n);
  return n;
}

function makeAdapter(mode) {
  return {
    rescoreTankSamples: function (nodes) {
      return nodes.map(function (node) {
        if (mode === 'old-carried') {
          const len = node.previousScores ? node.previousScores.length : 12;
          return {
            samples: node.samples,
            dead: false,
            deathFrame: -1,
            perFrameScores: new Array(len).fill(0),
            totalScore: 0,
            frameCount: len
          };
        }
        if (mode === 'new-earlier') {
          const len = 5;
          return {
            samples: node.samples,
            dead: true,
            deathFrame: len,
            perFrameScores: new Array(len).fill(0),
            totalScore: 0,
            frameCount: len
          };
        }
        // v102：A 与 B 在这一轮都报存活，靠每帧分数（10 vs 1）分出胜负；
        // A 的死亡结论只在后续 JS 融合确认时才写回，保证它一定被选中。
        if (node.previousDeathFrame > 0) {
          const len = 12;
          return {
            samples: node.samples,
            dead: false,
            deathFrame: -1,
            perFrameScores: new Array(len).fill(1),
            totalScore: len,
            frameCount: len
          };
        }
        const len = node.previousScores ? node.previousScores.length : 12;
        return {
          samples: node.samples,
          dead: false,
          deathFrame: -1,
          perFrameScores: new Array(len).fill(1),
          totalScore: len,
          frameCount: len
        };
      });
    },
    simulateTankBatchJsFused: function (state, operations, durationFrames) {
      const samples = [];
      for (let k = 0; k <= durationFrames; k++) samples.push({ t: k * 0.02, x: 5, y: 8, rot: 0 });
      return [{
        samples,
        hitWall: false,
        dead: true,
        deathFrame: 7
      }];
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

function setup(mode) {
  const sandbox = loadTree();
  const VT = sandbox.VantageTree;
  if (!VT || !VT.createTree || !VT.refreshCandidateScores || !VT.ensureLayerFresh || !VT.attachChild) {
    throw new Error('VantageTree API missing');
  }
  const tree = VT.createTree({ x: 5, y: 8, rot: 0 });
  tree.VT = VT;
  tree.commitNode = tree.root;
  tree.threats = makeThreats();
  tree._pendingThreats = [tree.threats[1]];
  tree.root.simState = { tank: { x: 5, y: 8, rot: 0 }, tGlobal: 0 };
  // v102：A 每帧 10 分、B 每帧 1 分，A 总分更高才会被选中；A 的重评分
  // 报存活（初始无死亡结论），软死结论只在 JS 融合确认时写回，
  // 保证选路比较器不会先把它当软死候选筛掉。
  const aOldDeath = (mode === 'confirm-route') ? -1 : 12;
  const A = makeChild(tree, tree.root, 1, aOldDeath, new Array(12).fill(10));
  const B = makeChild(tree, tree.root, 2, -1, new Array(12).fill(1));
  return { VT, tree, A, B, adapter: makeAdapter(mode) };
}

function assert(cond, msg) {
  if (!cond) throw new Error('ASSERT FAILED: ' + msg);
}

function scenarioOldCarried() {
  const { VT, tree, A } = setup('old-carried');
  VT.ensureLayerFresh(tree, makeAdapter('old-carried'), tree.root);
  assert(A.fullDeathFrame === 12, 'old death should be carried, got ' + A.fullDeathFrame);
  assert(A.perFrameScores.length === 12, 'old truncated scores should be kept, got ' + A.perFrameScores.length);
  assert(A.deathAuthority === 'rust-candidate', 'rescore result should stay a candidate, got ' + A.deathAuthority);
  console.log('A. old-bullet death carried PASS (fd=' + A.fullDeathFrame + ', pfs=' + A.perFrameScores.length + ', authority=' + A.deathAuthority + ')');
}

function scenarioNewEarlier() {
  const { VT, tree, A } = setup('new-earlier');
  VT.ensureLayerFresh(tree, makeAdapter('new-earlier'), tree.root);
  assert(A.fullDeathFrame === 5, 'new bullet should move death earlier, got ' + A.fullDeathFrame);
  assert(A.perFrameScores.length === 5, 'new earlier death should truncate scores, got ' + A.perFrameScores.length);
  assert(A.deathAuthority === 'rust-candidate', 'rescore result should stay a candidate, got ' + A.deathAuthority);
  console.log('B. new-bullet earlier death PASS (fd=' + A.fullDeathFrame + ', pfs=' + A.perFrameScores.length + ')');
}

function scenarioConfirmRoute() {
  const { VT, tree, A } = setup('confirm-route');
  VT.refreshCandidateScores(tree, makeAdapter('confirm-route'));
  assert(tree.root.next === A, 'node A should be selected as next');
  // v102：软死候选只要还有存活候选就会被选路跳过，所以这里不能断言
  // A 的死亡结论；改为断言被选中的节点确实走过了 JS 融合确认。
  assert(A.deathAuthority === 'fused', 'selected node must be JS-fused confirmed, got ' + A.deathAuthority);
  assert(A.fullDeathFrame === 7, 'selected node death should come from JS fused world, got ' + A.fullDeathFrame);
  console.log('C. execution-route JS confirmation PASS (next=n' + A.id + ', fd=' + A.fullDeathFrame + ', authority=' + A.deathAuthority + ')');
}

scenarioOldCarried();
scenarioNewEarlier();
scenarioConfirmRoute();
console.log('DIFF INCREMENTAL DEATH MERGE PASSED');
