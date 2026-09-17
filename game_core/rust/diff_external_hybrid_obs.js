#!/usr/bin/env node
// 外接 AI · P1 回归：Hybrid 观测构造器（1028 维）+ 动作映射 + 策略推理。
// 只读 game_core/external_ai/hybrid 与 game_core/js/external_ai_hybrid.js。
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const root = path.resolve(__dirname, '..');
const aiDir = path.join(root, 'external_ai', 'hybrid');

function fail(msg) { throw new Error(msg); }

// ---- 载入我们的观测构造器（IIFE 挂在 sandbox 上）----
const sb = { console, Math, Float32Array, Array, Object, Number, isFinite, Infinity, NaN };
sb.global = sb;
vm.runInContext(fs.readFileSync(path.join(root, 'js', 'external_ai_hybrid.js'), 'utf8'),
  vm.createContext(sb), { filename: 'external_ai_hybrid.js' });
const X = sb.VantageExternalHybrid;
assert(X, '外部 AI 模块没挂到 global 上');

// ---- 造一个 12x10 的空房间（四面墙 + 中间一根柱子），我方在 (5,5)，敌方在 (8,3) ----
const W = 12, H = 10, TILE = 10;
function wallTile(x, y) {
  if (x <= 0 || y <= 0 || x >= W - 1 || y >= H - 1) return true;   // 四面墙
  if (x === 6 && y === 5) return true;                             // 中间一根柱子
  return false;
}
const maze = { w: W, h: H, walkable: (x, y) => !wallTile(x, y) };
const units = X.makeUnits(null);

function mkTank(tx, ty, rot, extra) {
  const o = { x: tx * TILE + TILE / 2, y: ty * TILE + TILE / 2, rot: rot, vx: 0, vy: 0, turn: 0, ammoFrac: 1, canFire: true, alive: true, hitSomething: false, wallSliding: false };
  if (extra) for (const k in extra) o[k] = extra[k];
  return o;
}

// ---------- ① 布局与尺寸 ----------
const state = {
  maze: maze,
  self: mkTank(5, 5, 0),
  opp: mkTank(8, 3, 1.0),
  bullets: [{
    x: 5 * TILE + TILE / 2 + 8, y: 5 * TILE + TILE / 2, vx: -18, vy: 0,
    mine: false, bounced: true, lifeFrac: 0.5, threatMe: true, threatMe2: true, threatThem: false, etaMe: 0.25
  }],
  phase: [1, 0, 0, 0], clockFrac: 0.5, dodge9: [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8],
  idleStreak: 5, changeRate: 0.25, actions: [[1, 1, 0], [2, 0, 1], [0, 1, 1]]
};
const built = X.buildObservation(state, { units: units });
const v = built.values, mask = built.bulletMask;
assert.strictEqual(v.length, X.OBS_DIM, '观测长度必须是 1028');
assert.strictEqual(X.OBS_DIM, 1028, '模块自报的维度必须是 1028');
assert.strictEqual(built.warnings.length, 0, '不该有警告：' + JSON.stringify(built.warnings));
let nan = 0, oob = 0;
for (let i = 0; i < v.length; i++) {
  if (!isFinite(v[i])) nan++;
  if (Math.abs(v[i]) > 1.0000001) oob++;
}
assert.strictEqual(nan, 0, '观测里不该有 NaN');
assert.strictEqual(oob, 0, '观测里不该有越界值');

// ---------- ② 地图通道：存在 / 四壁 / 我在格 / 敌在格 ----------
const O = X.OFFSETS;
function cellBase(x, y) { return (x * X.MAP_H + y) * 7; }
// 镜像：我们的第 y 行 → 他们的第 (H-1-y) 行
function theirRow(y) { return H - 1 - y; }
let existsCount = 0, myFlags = [], oppFlags = [];
// 注意：观测里的地图是**镜像后**的（他们的 y 朝上），所以遍历时按他们的行循环，
// 再把每一行映回我们的 y：ourY = H-1-theirY。于是"他们的上方"= 我们的下方。
for (let x = 0; x < W; x++) {
  for (let yt = 0; yt < H; yt++) {
    const b = cellBase(x, yt);
    const y = H - 1 - yt;                       // 映回我们的行号
    const walk = !wallTile(x, y);
    assert.strictEqual(v[b], walk ? 1 : 0, `存在通道错：他们的(${x},${yt})=我们的(${x},${y})`);
    if (walk) existsCount++;
    const inb = (xx, yy) => (xx >= 0 && yy >= 0 && xx < W && yy < H);
    // 四壁 = 该方向相邻格不可走（越界也算墙）
    assert.strictEqual(v[b + 1], (!inb(x, y + 1) || wallTile(x, y + 1)) ? 1 : 0, `上墙错 (${x},${y})`);
    assert.strictEqual(v[b + 2], (!inb(x + 1, y) || wallTile(x + 1, y)) ? 1 : 0, `右墙错 (${x},${y})`);
    assert.strictEqual(v[b + 3], (!inb(x, y - 1) || wallTile(x, y - 1)) ? 1 : 0, `下墙错 (${x},${y})`);
    assert.strictEqual(v[b + 4], (!inb(x - 1, y) || wallTile(x - 1, y)) ? 1 : 0, `左墙错 (${x},${y})`);
    if (v[b + 5] > 0.5) myFlags.push([x, yt]);
    if (v[b + 6] > 0.5) oppFlags.push([x, yt]);
  }
}
assert(existsCount > 0, '房间里应该有可走格');
assert.strictEqual(myFlags.length, 1, '“我在格”必须恰好 1 个');
assert.deepStrictEqual(myFlags[0], [5, theirRow(5)], '“我在格”应在镜像后的位置');
assert.strictEqual(oppFlags.length, 1, '“敌在格”必须恰好 1 个');
assert.deepStrictEqual(oppFlags[0], [8, theirRow(3)], '“敌在格”应在镜像后的位置');

// ---------- ③ 左右手：镜像修正的核心断言 ----------
// 敌方在我**物理右侧**（rot=0 时朝向屏幕上方，+x 是右）→ “左”通道必须是负数。
{
  const s2 = Object.assign({}, state, { opp: mkTank(5, 5, 0, { x: state.self.x + 30, y: state.self.y }) });
  s2.bullets = [];
  const b2 = X.buildObservation(s2, { units: units });
  const relAhead = b2.values[O.OPPONENT], relLeft = b2.values[O.OPPONENT + 1];
  assert(Math.abs(relAhead) < 1e-9, '正右方的相对“前”分量应为 0，实际 ' + relAhead);
  assert(relLeft < 0, '正右方的相对“左”分量必须为负（镜像没做对就会是正），实际 ' + relLeft);
  // 敌方在我**物理左侧** → 左分量必须为正
  const s3 = Object.assign({}, state, { opp: mkTank(5, 5, 0, { x: state.self.x - 30, y: state.self.y }) });
  s3.bullets = [];
  const b3 = X.buildObservation(s3, { units: units });
  assert(b3.values[O.OPPONENT + 1] > 0, '正左方的相对“左”分量必须为正，实际 ' + b3.values[O.OPPONENT + 1]);
}

// ---------- ④ 自身 / 对手 / 子弹 / 历史 / dodge 的取值 ----------
{
  const selfX = v[O.SELF], selfY = v[O.SELF + 1];
  const worldW = W * TILE, worldH = H * TILE;
  assert(Math.abs(selfX - state.self.x / worldW) < 1e-6, '自身 x 归一化错');
  assert(Math.abs(selfY - (worldH - state.self.y) / worldH) < 1e-6, '自身 y 归一化错（镜像后）');
  assert(Math.abs(v[O.SELF + 2] - Math.sin(Math.PI - 0)) < 1e-6, '朝向 cos/sin 错（镜像后）');
  assert.strictEqual(v[O.SELF + 7], 1, '弹药通道应直传');
  assert.strictEqual(v[O.SELF + 9], 1, '存活通道应直传');
  assert.strictEqual(v[O.OPPONENT + 9], 1, '对手存活通道应为 1');
  // 子弹槽 0 填了，其余为空
  assert.strictEqual(mask[0], true, '第 0 槽应有效');
  assert.strictEqual(mask[1], false, '第 1 槽应为空');
  assert.strictEqual(v[O.BULLETS + 5], 1, '已反弹通道应为 1');
  assert.strictEqual(v[O.BULLETS + 7], 1, '“会打到我”通道应为 1');
  assert(Math.abs(v[O.BULLETS + 9] - 0.25) < 1e-6, '抵达时间通道应直传');
  assert(Math.abs(v[O.SELF_THREAT_COUNT] - 0.1) < 1e-6, '“正在打到我”的计数应为 1/10');
  // 阶段 / 时钟
  assert.strictEqual(v[O.PHASE], 1, '阶段 one-hot 第 1 位');
  assert(Math.abs(v[O.PHASE + 3] - 0.5) < 1e-6, '时钟通道');
  // 历史与换手率
  assert(Math.abs(v[O.LAST_ACTION] - 1) < 1e-6, '最近动作第 1 位');
  assert(Math.abs(v[O.CHANGE_RATE] - 0.25) < 1e-6, '换手率');
  // dodge 先验
  for (let i = 0; i < 9; i++) {
    assert(Math.abs(v[O.DODGE + i] - state.dodge9[i]) < 1e-6, 'dodge 第 ' + i + ' 项');
  }
  // 闲置帧数
  assert(Math.abs(v[O.IDLE_STREAK] - 5 / 25) < 1e-6, '闲置帧数归一化');
  // 越界地图要给出警告而不是崩掉
  const bigMaze = { w: 20, h: 14, walkable: () => true };
  const bigState = Object.assign({}, state, { maze: bigMaze, bullets: [] });
  const bigBuilt = X.buildObservation(bigState, { units: units });
  assert(bigBuilt.warnings.length === 1, '超出 12x10 必须给警告');
}

// ---------- ⑤ 动作映射（18 → 我们的输入）----------
{
  // action = 移动码*2 + 开火；移动码 = 油门*3 + 转向（油门 0后/1中/2前，转向 0左/1中/2右）
  const expect = [
    [0, false, true, true, false, false],    // 后左
    [1, false, true, true, false, true],     // 后左 + 开火
    [2, false, true, false, false, false],   // 后
    [4, false, true, false, true, false],    // 后右
    [6, false, false, true, false, false],   // 左
    [8, false, false, false, false, false],  // 静止
    [9, false, false, false, false, true],   // 静止 + 开火
    [10, false, false, false, true, false],  // 右
    [12, true, false, true, false, false],   // 前左
    [14, true, false, false, false, false],  // 前
    [15, true, false, false, false, true],   // 前 + 开火
    [16, true, false, false, true, false],   // 前右
    [17, true, false, false, true, true]     // 前右 + 开火
  ];
  expect.forEach(function (e) {
    const inp = X.actionToInputs(e[0]);
    assert.strictEqual(inp.forward, e[1], 'action ' + e[0] + ' forward');
    assert.strictEqual(inp.back, e[2], 'action ' + e[0] + ' back');
    assert.strictEqual(inp.left, e[3], 'action ' + e[0] + ' left');
    assert.strictEqual(inp.right, e[4], 'action ' + e[0] + ' right');
    assert.strictEqual(inp.fire, e[5], 'action ' + e[0] + ' fire');
    assert.strictEqual(X.inputsToMovement(inp), inp.movement, 'inputsToMovement 必须与解码一致');
  });
  // 9 个移动码覆盖 3 油门 × 3 转向，且互不相同
  const seen = {};
  for (let a = 0; a < 18; a++) {
    const inp = X.actionToInputs(a);
    assert(inp.movement >= 0 && inp.movement <= 8, '移动码范围');
    seen[inp.movement] = (seen[inp.movement] || 0) + 1;
  }
  for (let m = 0; m <= 8; m++) assert.strictEqual(seen[m], 2, '移动码 ' + m + ' 应出现 2 次（开火/不开火）');
}

// ---------- ⑥ 策略推理：能吃这份观测并给出合法动作 ----------
(async function main() {
  const manifest = JSON.parse(fs.readFileSync(path.join(aiDir, 'hybrid.json'), 'utf8'));
  const bytes = fs.readFileSync(path.join(aiDir, 'hybrid.bin'));
  const weights = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
  const mod = await import(require('url').pathToFileURL(path.join(aiDir, 'hybrid.js')).href);
  const policy = new mod.HybridPolicy(manifest, weights);

  const dodge = Float32Array.from(state.dodge9);
  const a1 = policy.act(v, mask, dodge);
  const a2 = policy.act(v, mask, dodge);
  assert(a1 >= 0 && a1 < 18, '动作号必须在 0..17，实际 ' + a1);
  assert.strictEqual(a1, a2, '同一输入必须给出同一动作（可复现）');
  const inp = X.actionToInputs(a1);

  // 每帧成本：观测构造 + 推理
  const N = 200;
  let t0 = process.hrtime.bigint();
  for (let i = 0; i < N; i++) X.buildObservation(state, { units: units });
  const obsMs = Number(process.hrtime.bigint() - t0) / 1e6 / N;
  const obs = X.buildObservation(state, { units: units });
  t0 = process.hrtime.bigint();
  for (let i = 0; i < N; i++) policy.act(obs.values, obs.bulletMask, dodge);
  const actMs = Number(process.hrtime.bigint() - t0) / 1e6 / N;

  console.log('diff_external_hybrid_obs PASS：观测 1028 维布局/左右手/历史/dodge 全部对上；' +
    '策略动作=' + a1 + '（前进=' + inp.forward + ' 后退=' + inp.back + ' 左=' + inp.left +
    ' 右=' + inp.right + ' 开火=' + inp.fire + '）；' +
    '单帧成本：观测 ' + obsMs.toFixed(3) + 'ms + 推理 ' + actMs.toFixed(2) + 'ms = ' +
    (obsMs + actMs).toFixed(2) + 'ms');
})().catch(function (e) {
  console.error('diff_external_hybrid_obs FAIL: ' + (e && e.message));
  process.exit(1);
});
