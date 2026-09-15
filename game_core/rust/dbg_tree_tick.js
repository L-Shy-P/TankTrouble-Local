#!/usr/bin/env node
/**
 * Vantage 树 tick 诊断脚本（v103）
 *
 * 在 Node 里跑**真实的** vantage_scoring.js + vantage_tree.js，用合成迷宫和
 * 极简适配器驱动 tick 循环，回答两类问题：
 *   ① 行为：开了「空场安全感知」AI 到底会不会主动走去安全地皮？关掉会不会停？
 *   ② 性能：每帧花多少时间、卡在哪一段、有没有“每帧全树重算”。
 *
 * 用法：
 *   node dbg_tree_tick.js                          # 默认：开阔房间，起点(1,5)，空场开，400 tick
 *   node dbg_tree_tick.js --empty 0                # 关掉空场安全感知（应当原地不动）
 *   node dbg_tree_tick.js --bullets 3              # 跑到 30% 处放 3 颗子弹
 *   node dbg_tree_tick.js --ticks 1200 --startx 1 --starty 9
 *   node dbg_tree_tick.js --corridor               # 换成 1 格宽的长走廊
 *   node dbg_tree_tick.js --verbose                # 打印逐帧细节
 *
 * 注意：这里的适配器是「简化物理」（匀速直行 + 原地转向 + 撞墙夹住），
 * 只用来验证**决策与性能**，不替代游戏里的 Box2D 融合世界。
 *
 * 已知限制（别被误导）：
 *   本脚本里「运行中新增子弹 → 树把该弹纳入威胁」这条链路没有跑通
 *   （maxTreeThreats 恒为 0），原因在脚本自身的时序/stub，不是产品问题——
 *   真实游戏导出的诊断 JSON 里 threats=10、threatIds 非空，链路是好的。
 *   所以：
 *     · 「空场会不会走」用本脚本验证（已通过）；
 *     · 「有子弹时地形与安全的配比」用 debugObjective 的数值验证
 *       （安全性因子、方向增益、地形加成）；
 *     · 「子弹逼近时是否真的躲」必须到真实游戏里看。
 */
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
const TICKS = argNum('ticks', 400);
const START_X = argNum('startx', 1);
const START_Y = argNum('starty', 5);
const VERBOSE = argv.indexOf('--verbose') >= 0;
const CORRIDOR = argv.indexOf('--corridor') >= 0;
const INCOMING = argv.indexOf('--incoming') >= 0;   // 放一颗“真的会打到”的子弹

const Constants = {
  AI: { MAZE_MAX_DEAD_END_PENALTY: 5, PATH_STEP_SIZE: 0.5 },
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

// 房间：外圈是墙，里面是开阔场地。走廊：只有中间一行可走。
const W = CORRIDOR ? 20 : 15;
const H = CORRIDOR ? 5 : 11;
const walkable = (t) => CORRIDOR
  ? (t && t.y === 2 && t.x >= 0 && t.x < W)
  : (t && t.x >= 1 && t.x <= W - 2 && t.y >= 1 && t.y <= H - 2);
const maze = {
  getWidth: () => W,
  getHeight: () => H,
  isPositionInsideMaze: walkable,
  getDeadEndPenalty: () => 0
};

const TILE = 10;
const startX = CORRIDOR ? Math.max(0, Math.min(W - 1, START_X)) : Math.max(1, Math.min(W - 2, START_X));
const startY = CORRIDOR ? 2 : Math.max(1, Math.min(H - 2, START_Y));
const tank = { x: (startX + 0.5) * TILE, y: (startY + 0.5) * TILE, rot: 0 };
const projectiles = [];

function makeAdapter() {
  return {
    constants: {
      FRAME_DT: 0.02, BULLET_SPEED: 20, BULLET_RADIUS: 0.25, PATH_STEP_SIZE: 0.5,
      MAZE_TILE_SIZE: TILE, TANK_FORWARD_SPEED: 4, TANK_BACK_SPEED: 4,
      TANK_ROTATION_SPEED: 1.05,
      TANK_WIDTH: 3, TANK_HEIGHT: 4, TANK_HALF_WIDTH: 1.5, TANK_HALF_HEIGHT: 2,
      TURRET_WIDTH: 0.7, TURRET_HEIGHT: 1.4, TURRET_OFFSET_Y: -2,
      DEATH_PREFILTER_RADIUS: 3, PIXELS_PER_METER: 20
    },
    getTankState: () => ({ x: tank.x, y: tank.y, rot: tank.rot }),
    getProjectiles: () => projectiles.slice(),
    getMaze: () => maze,
    // 按子弹真实速度方向生成轨迹（以前写死 +x，朝左飞的弹会被当成远离，
    // 评分模块就看不到它，诊断结论会失真——实测踩到）。
    getProjectilePaths: () => projectiles.map(function (p) {
      const pth = [];
      const vx = Number(p.speedX) || 0, vy = Number(p.speedY) || 0;
      const vm = Math.sqrt(vx * vx + vy * vy) || 1;
      const stepX = vx / vm * 0.4, stepY = vy / vm * 0.4;
      for (let i = 0; i < 80; i++) pth.push({ x: p.x + stepX * i, y: p.y + stepY * i });
      return { id: p.id, path: pth, speed: p.speed, x: p.x, y: p.y };
    }),
    checkDeath: () => false,
    checkWall: () => false,
    bulletPosAt: (pth, speed, q) => ({ x: pth[0].x + speed * q, y: pth[0].y }),
    // 简化运动学：前进/后退沿朝向 4m/s，左右原地转 1.05rad/s，位置夹在可走区内。
    simulateTank: function (state, inputs, frames) {
      const samples = [{ x: state.x, y: state.y, rot: state.rot }];
      let x = state.x, y = state.y, rot = state.rot;
      const minX = 1.5 * TILE, maxX = (W - 1.5) * TILE;
      const minY = CORRIDOR ? 2.5 * TILE : 1.5 * TILE;
      const maxY = CORRIDOR ? 2.5 * TILE : (H - 1.5) * TILE;
      for (let i = 0; i < frames; i++) {
        const rotIn = (inputs && inputs.right ? 1 : 0) - (inputs && inputs.left ? 1 : 0);
        if (rotIn) rot += rotIn * 1.05 * 0.02;
        const fwd = (inputs && inputs.forward ? 1 : 0) - (inputs && inputs.back ? 1 : 0);
        if (fwd) {
          x += Math.sin(rot) * 4.0 * 0.02 * fwd;
          y += -Math.cos(rot) * 4.0 * 0.02 * fwd;
        }
        x = Math.max(minX, Math.min(maxX, x));
        y = Math.max(minY, Math.min(maxY, y));
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
  console,
  performance: { now: () => Number(process.hrtime.bigint()) / 1e6 },
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
vm.runInContext(fs.readFileSync(path.join(jsDir, 'vantage_scoring.js'), 'utf8'), ctx, { filename: 'vantage_scoring.js' });
vm.runInContext(fs.readFileSync(path.join(jsDir, 'vantage_tree.js'), 'utf8'), ctx, { filename: 'vantage_tree.js' });
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

// 复刻 ai_vantage 里“无弹直接驾驶”的那条通道：朝目标格中心转，对准了再开。
function driveToTarget() {
  if (!ai.debugTarget) return null;
  const tx = (ai.debugTarget.x + 0.5) * TILE, ty = (ai.debugTarget.y + 0.5) * TILE;
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

const opCount = {};
let worstTickMs = 0, totalMs = 0;
let navTicks = 0, minThreatInSec = null, maxTreeThreats = 0, lastThreatIds = '', lastLive = -1;
const navLog = [];   // [tick, 还有几秒挨打, 导航是否激活]
// 子弹投放时机：默认 30% 处；--bulletat 0 表示开局就有弹（用来对比
// “运行中新增子弹”这条路径是否被脚本正确复现）。
const bulletAt = argNum('bulletat', Math.floor(TICKS * 0.3));

for (let tickNo = 0; tickNo < TICKS; tickNo++) {
  if (BULLETS && tickNo === bulletAt) {
    for (let b = 0; b < BULLETS; b++) {
      if (INCOMING) {
        // 从右侧朝坦克那一行飞过来（真的会进命中圈）：起点 (12,5) 朝左。
        projectiles.push({ id: 'in' + b, x: (W - 2) * TILE, y: startY * TILE + 5, speed: 20, speedX: -20, speedY: 0 });
      } else {
        // 横穿但不在坦克那一行：永远不会打到（用来测“子弹还远时提前走位”）。
        projectiles.push({ id: 'b' + b, x: (2 + b) * TILE, y: CORRIDOR ? 2 * TILE + 5 : 3 * TILE, speed: 20, speedX: 20, speedY: 0 });
      }
    }
  }
  if (BULLETS && tickNo > bulletAt) projectiles.forEach(p => { p.x += (p.speedX < 0 ? -0.4 : 0.4); });

  // 本脚本里“树自动读取真实子弹数”那条链路没跑通（见文件头“已知限制”），
  // 这里直接喂给树，保证“有子弹”这个条件在打分逻辑里成立。
  VT.setLiveProjectilesNow(projectiles.length);
  const t0 = process.hrtime.bigint();
  try {
    VT.tick(ai, 0.02);
  } catch (e) {
    console.error('tick threw at ' + tickNo + ':', e && e.stack);
    process.exit(1);
  }
  // 驱动通道需和真实游戏一致：
  //   · 有自动/点击目标（空场通道）→ 走迷宫最短路直接驾驶；
  //   · 否则 → 用树当前选出的操作驱动（ai_vantage 每帧提交的就是它）。
  const dIn = driveToTarget();
  if (dIn) {
    simulateDirect(dIn, 1);
  } else {
    const treeOp = VT.getDesiredOperation();
    if (treeOp && treeOp.inputs) simulateDirect(treeOp.inputs, 1);
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  totalMs += ms;
  if (ms > worstTickMs) worstTickMs = ms;

  const tree = VT.getTree();
  const op = tree && tree.commitNode ? tree.commitNode.next : null;
  const name = op ? (op.opName || '?') : '-';
  opCount[name] = (opCount[name] || 0) + 1;
  if (tree && tree.threats && tree.threats.length > maxTreeThreats) maxTreeThreats = tree.threats.length;
  if (tree && tree.threatIds) lastThreatIds = String(tree.threatIds);
  if (tree && typeof tree._liveProjectileCount === 'number') lastLive = tree._liveProjectileCount;

  // v104：记录“子弹还剩几秒打到”和“杀戮场是否在接管走位”，用来检查
  // “子弹远→提前占位、子弹近→让位躲弹”这条切换是不是真的发生。
  const et = VT.earliestThreatInSec ? VT.earliestThreatInSec() : null;
  const navOn = VT.isTerrainNavigationActive ? !!VT.isTerrainNavigationActive() : false;
  if (navOn) navTicks++;
  if (et !== null && (minThreatInSec === null || et < minThreatInSec)) minThreatInSec = et;
  if (BULLETS) {
    const prev = navLog.length ? navLog[navLog.length - 1] : null;
    // 只在“有没有会打到的弹”或“导航开关”发生变化时记一笔
    const changed = !prev ||
      ((prev[1] === null) !== (et === null)) ||
      (prev[2] !== navOn);
    if (changed) navLog.push([tickNo, et === null ? null : Number(et.toFixed(2)), navOn]);
  }

  if (VERBOSE && (tickNo < 12 || tickNo % 60 === 0)) {
    console.log('  t' + tickNo +
      ' tank=(' + tank.x.toFixed(1) + ',' + tank.y.toFixed(1) + ') rot=' + tank.rot.toFixed(2) +
      ' tile=(' + Math.floor(tank.x / TILE) + ',' + Math.floor(tank.y / TILE) + ')' +
      ' nodes=' + (tree ? tree.nodeCount : -1) +
      ' next=' + name +
      ' autoTarget=' + JSON.stringify(VT.killfieldAutoTarget()) +
      ' anchor=' + JSON.stringify(VT.getKillfieldAnchorTile()) +
      ' ms=' + ms.toFixed(1));
  }
}

const tree = VT.getTree();
const perf = VT.getPerf();
console.log('=== dbg_tree_tick（' + (CORRIDOR ? '走廊' : '房间') + ' ' + W + 'x' + H + '） ===');
console.log('emptyFieldSafety  =', EMPTY_SAFETY === 1, '  bullets =', BULLETS, '  ticks =', TICKS);
console.log('start tile        =', startX + ',' + startY,
  '  end tile =', Math.floor(tank.x / TILE) + ',' + Math.floor(tank.y / TILE));
console.log('anchor tile       =', JSON.stringify(VT.getKillfieldAnchorTile()));
console.log('op counts         =', JSON.stringify(opCount));
console.log('nodes             =', tree ? tree.nodeCount : 'n/a');
console.log('targetReroutes    =', (tree && tree.stats && tree.stats.targetReroutes) || 0,
  '（目标变化触发的全树重算；正常应只在切换目标时 +1）');
console.log('moveTargetWrites  =', VT.getMoveTargetWrites ? VT.getMoveTargetWrites() : 'n/a');
if (BULLETS) {
  console.log('maxTreeThreats    =', maxTreeThreats, '（树自己看到的威胁数；0 = 树没吃到子弹）');
console.log('lastThreatIds     = "' + lastThreatIds + '"  lastLive =', lastLive);
console.log('terrainNavTicks   =', navTicks, '/', TICKS,
    '（杀戮场接管走位的帧数；子弹逼近时应自动停掉）');
  console.log('minThreatInSec    =', minThreatInSec,
    '（过程中最近的一次“还有几秒挨打”；null = 全程都打不到）');
  // 打印切换点附近的采样：看出“挨打时间”和“是否接管”的对应关系
  console.log('navSwitches       =', navLog.length ? navLog.map(r =>
    't' + r[0] + ':in' + (r[1] === null ? '∞' : r[1]) + 's/nav' + (r[2] ? '1' : '0')).join('  ') : '（无变化）');
}
console.log('worst tick ms     =', worstTickMs.toFixed(1), '  avg =', (totalMs / TICKS).toFixed(2));
console.log('perf              =', JSON.stringify({ avgMs: perf.avgMs, maxMs: perf.maxMs, win60: perf.win60, phases: perf.phases }));
if (perf.worstFrames && perf.worstFrames.length) {
  console.log('worstFrames(>30ms)= ');
  perf.worstFrames.forEach(function (f) { console.log('   ' + JSON.stringify(f)); });
} else {
  console.log('worstFrames(>30ms)= 无');
}
