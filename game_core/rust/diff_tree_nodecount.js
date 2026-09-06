#!/usr/bin/env node
// Regression test: detached-descendant double detach must never drive the
// active tree node counter negative.
//
// Scenario reconstructed from the live tree bug (v75 structure history):
// a batch rescore writes ancestor results first.  An ancestor death-shorten
// detaches its subtree; a later job still writes a descendant result, and
// that descendant shortens again.  Before the fix this double detach
// decremented nodeCount twice for the same nodes and could drive it negative.
//
// Runs the REAL game_core/js/vantage_tree.js in a minimal Node VM with the
// REAL game_core/js/vantage_scoring.js (Constants stubbed just enough to
// construct tree nodes).

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

function loadModules() {
  const sandbox = {
    console,
    performance,
    Math,
    JSON,
    Array,
    Object,
    String,
    Number,
    isFinite,
    parseInt,
    parseFloat,
    Infinity,
    NaN,
    Date,
    Constants
  };
  sandbox.global = sandbox;
  const ctx = vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(scoringPath, 'utf8'), ctx, { filename: scoringPath });
  vm.runInContext(fs.readFileSync(treePath, 'utf8'), ctx, { filename: treePath });
  return sandbox;
}

function main() {
  const sandbox = loadModules();
  const VT = sandbox.VantageTree;
  if (!VT || !VT.createTree || !VT.createTreeNode || !VT.attachChild || !VT.applyRolloutScore) {
    throw new Error('VantageTree API missing');
  }

  const tree = VT.createTree({ x: 0, y: 0, rot: 0 });
  function makeNode(parent) {
    const n = VT.createTreeNode(
      parent,
      { forward: true, back: false, left: false, right: false },
      { tank: { x: 0, y: 0, rot: 0 }, tGlobal: 0 }
    );
    n.plannedFrames = 10;
    n.segmentFrames = 10;
    n.rolloutSamples = [{ x: 0, y: 0, rot: 0 }, { x: 1, y: 0, rot: 0 }, { x: 2, y: 0, rot: 0 }];
    n.perFrameScores = [1, 2];
    n.status = 'alive';
    return n;
  }

  const A = makeNode(tree.root);
  const D = makeNode(A);
  const L = makeNode(D);
  VT.attachChild(tree, tree.root, A);
  VT.attachChild(tree, A, D);
  VT.attachChild(tree, D, L);

  const initial = tree.nodeCount;
  const deadResult = { perFrameScores: [0, -100], totalScore: -100, dead: true, deathFrame: 2 };

  // Simulate the bad batch ordering: ancestor first, then detached descendant.
  VT.applyRolloutScore(tree, A, deadResult);
  VT.applyRolloutScore(tree, D, deadResult);
  VT.applyRolloutScore(tree, L, deadResult);

  if (tree.nodeCount < 1) {
    throw new Error('nodeCount is negative: ' + tree.nodeCount);
  }
  // root + A remain active; D and L were detached exactly once.
  if (tree.nodeCount !== 2) {
    throw new Error('expected nodeCount=2, got ' + tree.nodeCount);
  }
  if (D.parent !== null || L.parent !== null) {
    throw new Error('detached descendants still have parent links');
  }
  console.log('diff_tree_nodecount PASS (count=' + tree.nodeCount + ', initial=' + initial + ')');
}

main();
