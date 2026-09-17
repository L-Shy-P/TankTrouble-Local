#!/usr/bin/env node
// v102 diagnostic/debug harness: drives the REAL VantageTree tick loop on a
// synthetic maze with a stub adapter, to reproduce "empty-field safety does not
// move the tank" and to time the per-tick cost with and without projectiles.
//
// Usage:
//   node dbg_tree_tick.js                  # default: corridor maze, 240 ticks, no bullets
//   node dbg_tree_tick.js --bullets 1      # spawn one bullet at tick 60
//   node dbg_tree_tick.js --empty 1        # empty-field safety ON
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const jsDir = path.join(root, 'js');

const argv = process.argv.slice(2);
function argNum(name, dflt) {
  const i = argv.indexOf('--' + name);
  return i >= 0 ? Number(argv[i + 1]) : dflt;
}
const BULLETS = argNum('bullets', 0);
const EMPTY_SAFETY = argNum('empty', 1);
const TICKS = argNum('ticks', 240);
const START_TILE = argNum('start', 1);

const Constants = {
  AI: { MAZE_MAX_DEAD_END_PENALTY: 5, PATH_STEP_SIZE: 0.5 },
  BULLET_SPEED_M: 20,
  MAZE_TILE_SIZE: { m: 10 },
  BULLET: { RADIUS: { m: 0.25 }, OFFSET: { m: 2.5 } },
  TANK: { WIDTH: { m: 3 }, HEIGHT: { m: 4 } },
  BULLET_TURRET: { WIDTH: { m: 0.7 }, HEIGHT: { m: 1.4 }, OFFSET_X: { m: 0 }, OFFSET_Y: { m: -2 } },
  LASER_TURRET: { ANTENNA_WIDTH: { m: 0.1 }, ANTENNA_HEIGHT: { m: 1.4 }, ANTENNA_OFFSET_X: { m: 0 }, ANTENNA_OFFSET_Y: { m: -2 }, DISH_WIDTH: { m: 2 }, DISH_HEIGHT: { m: 0.5 }, DISH_OFFSET_X: { m: 0 }, DISH_OFFSET_Y: { m: -1.85 } },
  DOUBLE_BARREL_TURRET: { WIDTH: { m: 1.6 }, HEIGHT: { m: 1.1 }, OFFSET_X: { m: 0 }, OFFSET_Y: { m: -1.75 } },
  SHOTGUN_TURRET: { WIDTH: { m: 1.4 }, HEIGHT: { m: 1.35 }, OFFSET_X: { m: 0 }, OFFSET_Y: { m: -1.95 } },
  MISSILE_TURRET: { WIDTH: { m: 0.3 }, CENTER_HEIGHT: { m: 1.4 }, SIDE_HEIGHT: { m: 0.4 }, OFFSET_X: { m: 0 }, OFFSET_Y: { m: -1.95 } },
  GATLING_GUN_TURRET: { WIDTH: { m: 1.4 }, HEIGHT: { m: 1.35 }, OFFSET_X: { m: 0 }, OFFSET_Y: { m: -1.95 } },
  PIXELS_PER_METER: 20,
  FRAME_DT: 0.02
};

// ---- 15x11 square room: outer ring is wall, 13x9 open inside ----
// 开阔房间里唯一的安全方向就是“往中间/往开阔处”，正好检验空场安全感知。
const W = 15, H = 11;
const maze = {
  getWidth: () => W,
  getHeight: () => H,
  isPositionInsideMaze: (t) => t && t.x >= 1 && t.x <= W - 2 && t.y >= 1 && t.y <= H - 2,
  getDeadEndPenalty: (t) => 0
};

const START_X = argNum('startx', 1);
const START_Y = argNum('starty', 1);
const tank = { x: (START_X + 0.5) * 10, y: (START_Y + 0.5) * 10, rot: 0 };   // 朝上
const projectiles = [];
let tickNo = 0;

function makeAdapter() {
  return {
    constants: {
      FRAME_DT: 0.02, BULLET_SPEED: 20, BULLET_RADIUS: 0.25, PATH_STEP_SIZE: 0.5,
      MAZE_TILE_SIZE: 10, TANK_FORWARD_SPEED: 4, TANK_BACK_SPEED: 4,
      TANK_ROTATION_SPEED: 3,
      TANK_WIDTH: 3, TANK_HEIGHT: 4, TANK_HALF_WIDTH: 1.5, TANK_HALF_HEIGHT: 2,
      TURRET_WIDTH: 0.7, TURRET_HEIGHT: 1.4, TURRET_OFFSET_Y: -2,
      DEATH_PREFILTER_RADIUS: 3, PIXELS_PER_METER: 20
    },
    getProjectilePaths: function (bounces, maxLen) {
      return projectiles.map(function (p) {
        const path = [];
        for (let i = 0; i < 80; i++) path.push({ x: p.x + i * 0.4, y: p.y });
        return { id: p.id, path: path, speed: p.speed, x: p.x, y: p.y };
      });
    },
    operations: null,
    getTankState: () => ({ x: tank.x, y: tank.y, rot: tank.rot }),
    getProjectiles: () => projectiles.slice(),
    getMaze: () => maze,
    checkDeath: () => false,
    checkWall: () => false,
    bulletPosAt: (p, speed, q) => ({ x: p[0].x + speed * q, y: p[0].y }),
    // 简易运动学：前进/后退沿朝向走（4 m/s），左右原地转（3 rad/s），
    // 位置按迷宫边界夹住（撞墙后停住 = 命中墙角被卡住）。
    simulateTank: function (state, inputs, frames) {
      const samples = [{ x: state.x, y: state.y, rot: state.rot }];
      let x = state.x, y = state.y, rot = state.rot;
      const TILE = 10;
      for (let i = 0; i < frames; i++) {
        const rotIn = (inputs && inputs.right ? 1 : 0) - (inputs && inputs.left ? 1 : 0);
        if (rotIn) rot += rotIn * 1.05 * 0.02;
        const fwd = (inputs && inputs.forward ? 1 : 0) - (inputs && inputs.back ? 1 : 0);
        if (fwd) {
          x += Math.sin(rot) * 4.0 * 0.02 * fwd;
          y += -Math.cos(rot) * 4.0 * 0.02 * fwd;
        }
        // walkable = 1..W-2 / 1..H-2；中心留半格余量
        x = Math.max(1.5 * TILE, Math.min((W - 1.5) * TILE, x));
        y = Math.max(1.5 * TILE, Math.min((H - 1.5) * TILE, y));
        samples.push({ x: x, y: y, rot: rot });
      }
      return { samples: samples, hitWall: false, dead: false, deathFrame: -1 };
    },
    simulateTankBatch: function (state, operations, frames) {
      return operations.map(op => {
        const r = this.simulateTank(state, op.inputs, frames);
        r.opName = op.name;
        return r;
      });
    },
    simulateTankBatchJsFused: null,
    rescoreTankSamples: null
  };
}

const sandbox = {
  console, performance: { now: () => Date.now() },
  Math, JSON, Object, Array, String, Number, Boolean, isFinite, parseInt, parseFloat,
  Infinity, NaN, Date, Set, Map,
  Constants,
  VantageSandbox: {
    OPERATIONS: [
      { name: '静止', inputs: { forward: false, back: false, left: false, right: false } },
      { name: '前', inputs: { forward: true, back: false, left: false, right: false } },
      { name: '后', inputs: { forward: false, back: true, left: false, right: false } },
      { name: '左', inputs: { forward: false, back: false, left: true, right: false } },
      { name: '右', inputs: { forward: false, back: false, left: false, right: true } },
      { name: '前左', inputs: { forward: true, back: false, left: true, right: false } },
      { name: '前右', inputs: { forward: true, back: false, left: false, right: true } },
      { name: '后左', inputs: { forward: false, back: true, left: true, right: false } },
      { name: '后右', inputs: { forward: false, back: true, left: false, right: true } }
    ],
    fusedEnabled: () => false,
    clearCaches: () => {}
  }
};
sandbox.global = sandbox;
const ctx = vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(jsDir, 'vantage_scoring.js'), 'utf8'), ctx, { filename: 'scoring.js' });
vm.runInContext(fs.readFileSync(path.join(jsDir, 'vantage_tree.js'), 'utf8'), ctx, { filename: 'tree.js' });
const VT = sandbox.VantageTree;

const adapter = makeAdapter();
const ai = {
  _vantageAdapter: adapter,
  aiId: 1,
  gameController: { getMaze: () => maze },
  debugTarget: null,
  setDebugTarget: function (x, y) { this.debugTarget = { x: x, y: y }; },
  clearDebugTarget: function () { this.debugTarget = null; }
};
// 简易“直接驾驶”复刻：朝目标格中心开（ai_vantage 无弹点击走的就是这条路）
function driveToTarget() {
  if (!ai.debugTarget) return null;
  const tx = (ai.debugTarget.x + 0.5) * 10, ty = (ai.debugTarget.y + 0.5) * 10;
  const dx = tx - tank.x, dy = ty - tank.y;
  if (Math.abs(dx) < 3 && Math.abs(dy) < 3) { ai.clearDebugTarget(); return null; }
  const want = Math.atan2(dx, -dy);
  let diff = want - tank.rot;
  diff = Math.atan2(Math.sin(diff), Math.cos(diff));
  return {
    forward: Math.abs(diff) < 0.35,
    back: false,
    left: diff < -0.08,
    right: diff > 0.08
  };
}
function simulateDirect(inputs, frames) {
  const r = adapter.simulateTank({ x: tank.x, y: tank.y, rot: tank.rot }, inputs, frames);
  const l = r.samples[r.samples.length - 1];
  tank.x = l.x; tank.y = l.y; tank.rot = l.rot;
}

// 默认配置（与面板默认预设一致）
VT.setGrowLayersPerTick(1);
VT.setNodeCapEnabled(false);
VT.setHorizonCapEnabled(true);
VT.setHorizonSec(8);
VT.setRefineBeyondLimits(true);
VT.setContinuousRefine(false);
VT.setGrowWithoutThreatsEnabled(true);
VT.setWarmupMaxNodes(500);
VT.setKillfieldEnabled(true);
VT.setKillfieldWeight(1.0);
VT.setEmptyFieldSafety(EMPTY_SAFETY === 1);
VT.setTargetMixEnabled(true);
VT.setTargetMixRatio(0.5);
VT.setScoreOnlyPlanned(false);
VT.setLiveProjectilesNow(0);

const ops = sandbox.VantageSandbox.OPERATIONS;
for (let t = 0; t < 200; t++) { VT.tick(ai, 0.02); }
console.log('after warmup: nodes=' + (VT.getTree() ? VT.getTree().nodeCount : -1));
console.log('warmup perf=' + JSON.stringify(VT.getPerf()));
VT.resetPerf();
for (let i = 0; i < 5; i++) projectiles.push({ id: 'b' + i, x: 40 + i * 8, y: 25, speed: 20, speedX: 20, speedY: 0 });
const t0 = process.hrtime.bigint();
for (let t = 0; t < 120; t++) { VT.tick(ai, 0.02); projectiles.forEach(p => p.x += 0.4); }
const ms = Number(process.hrtime.bigint() - t0) / 1e6;
console.log('stress 120 ticks = ' + ms.toFixed(1) + 'ms');
console.log('stress perf=' + JSON.stringify(VT.getPerf()));
console.log('nodes now=' + (VT.getTree() ? VT.getTree().nodeCount : -1))
