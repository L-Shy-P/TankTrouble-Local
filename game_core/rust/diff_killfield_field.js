#!/usr/bin/env node
// Killfield 移植 · 第一步回归：他们的「逆杀戮场」（field.js）能不能在我们的迷宫上跑，
// 且结果符合物理直觉（目标格本身不收票、有视线的格子得票高、瞄准角指向目标、镜像对称）。
'use strict';
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const assert = require('assert');

const dir = path.resolve(__dirname, '..', 'external_ai', 'killfield');

async function main() {
  const C = await import(pathToFileURL(path.join(dir, 'constants.js')).href);
  const { buildGameView } = await import(pathToFileURL(path.join(dir, 'gameView.js')).href);
  const { InverseDensityFieldBuilder } = await import(pathToFileURL(path.join(dir, 'field.js')).href);

  // ---- 12x10 测试迷宫：四面墙 + 一根柱子（和我们观测测试里的一致）----
  const W = 12, H = 10, TILE = 10;
  function wallTile(x, y) {
    if (x <= 0 || y <= 0 || x >= W - 1 || y >= H - 1) return true;
    if (x === 6 && y === 5) return true;
    return false;
  }
  const maze = {
    getWidth: () => W,
    getHeight: () => H,
    isPositionInsideMaze: (t) => t && !wallTile(t.x, t.y)
  };

  const view = buildGameView(maze);
  assert.strictEqual(view.scale, C.units().TILE_M, '格子尺寸要取常量表里的 10');
  assert.strictEqual(view.maze.length, W, '视图宽度');
  assert.strictEqual(view.maze[0].length, H, '视图高度');
  assert(view.reachable.length === (W - 2) * (H - 2) - 1, '可达格数 = 内部格 - 柱子，实际 ' + view.reachable.length);
  assert.strictEqual(view.walls.length, W * H - view.reachable.length, '墙格数应等于总格数减可达格');
  assert.strictEqual(view.wallHit(1.5 * TILE, 1.5 * TILE), false, '界内可走格不是墙（用格(1,1)，(0,0) 是外墙）');
  assert.strictEqual(view.wallHit(6.5 * TILE, 5.5 * TILE), true, '柱子是墙');
  assert.strictEqual(view.wallHit(-1, 5), true, '界外当墙');

  // ---- 逆杀戮场：以敌人格 (8,3) 为中心 ----
  const enemy = [8, 3];
  const builder = new InverseDensityFieldBuilder(view, 512, 2, 3 * C.FPS, 7);
  let t0 = process.hrtime.bigint();
  const field = builder.build(enemy);
  const ms512 = Number(process.hrtime.bigint() - t0) / 1e6;

  // ① 目标格可以收票（反弹后从自己格打回来是合法的），但绝不该是最佳射击格
  assert(field.countAt(enemy) < field.maxCount,
    '敌人所在格不该是最佳射击格（' + field.countAt(enemy) + ' vs max ' + field.maxCount + '）');

  // ② 同一行、视线通畅的格子必须有票
  const los = [5, 3];
  assert(field.countAt(los) > 0, '有视线的格子应当有票，实际 ' + field.countAt(los));

  // ③ 超出"三秒内到达"射程的格子必须没票（他们自己的规则：只有 3 秒内到的子弹才投票）
  //    弹速 0.4 米/帧、150 帧 → 60 米 = 6 格；敌人(8,3)到(1,3)是 7 格，够不着。
  assert.strictEqual(field.countAt([1, 3]), 0,
    '射程外的格子不该有票，实际 ' + field.countAt([1, 3]));

  // ④ 柱子后面的格子票数应当不超过视线通畅处
  const behind = [6, 6];
  assert(field.countAt(behind) <= field.countAt(los),
    '柱子后面的格不该比有视线的格票更多（' + field.countAt(behind) + ' vs ' + field.countAt(los) + '）');

  // ④ 瞄准角：从有视线的格子看，最佳瞄准方向应当指向敌人
  const [angle, mass] = field.bestAimAt(los, null);
  assert(angle !== null && mass > 0, '有视线的格子应当有最佳瞄准角');
  const wantAngle = Math.atan2((enemy[1] + 0.5 - (los[1] + 0.5)) * TILE,
    (enemy[0] + 0.5 - (los[0] + 0.5)) * TILE);
  let dA = angle - wantAngle;
  dA = Math.atan2(Math.sin(dA), Math.cos(dA));
  assert(Math.abs(dA) < 8 * Math.PI / 180,
    '最佳瞄准角应指向敌人（误差 ' + (dA * 180 / Math.PI).toFixed(1) + '°）');

  // ⑤ 分层/引导场：值应当在合理范围、且可达格上有定义
  const v = field.valueAt(los);
  assert(Number.isFinite(v), 'valueAt 必须是有限数');
  const tier = field.tierAt(enemy);
  assert(Number.isFinite(tier) && tier >= 0, 'tier 必须是非负有限数，实际 ' + tier);
  assert(Number.isFinite(field.guidanceAt(los)), 'guidanceAt 必须是有限数');

  // ⑥ 镜像对称性：把迷宫左右镜像，镜像格的票数应当一致（射线扇是对称的）
  const mirrored = {
    getWidth: () => W,
    getHeight: () => H,
    isPositionInsideMaze: (t) => t && !wallTile((W - 1) - t.x, t.y)
  };
  const mField = new InverseDensityFieldBuilder(buildGameView(mirrored), 512, 2, 3 * C.FPS, 7)
    .build([(W - 1) - enemy[0], enemy[1]]);
  let maxDiff = 0, checked = 0;
  for (let x = 1; x < W - 1; x++) {
    for (let y = 1; y < H - 1; y++) {
      const a = field.countAt([x, y]);
      const b = mField.countAt([(W - 1) - x, y]);
      maxDiff = Math.max(maxDiff, Math.abs(a - b));
      checked++;
    }
  }
  assert(maxDiff <= Math.max(2, checked * 0.01),
    '镜像格的票数应当基本一致，最大差 ' + maxDiff);

  // ---- 计时：我们的迷宫、512 与 2048 条射线 ----
  // 计时要在 JIT 预热之后量（第一次跑总是偏慢几十倍）
  function timeRays(rays, rounds) {
    for (let i = 0; i < 3; i++) new InverseDensityFieldBuilder(view, rays, 2, 3 * C.FPS, 7).build(enemy);
    const t = process.hrtime.bigint();
    for (let i = 0; i < rounds; i++) new InverseDensityFieldBuilder(view, rays, 2, 3 * C.FPS, 7).build(enemy);
    return Number(process.hrtime.bigint() - t) / 1e6 / rounds;
  }
  const msWarm512 = timeRays(512, 5);
  const msWarm1024 = timeRays(1024, 5);
  const ms2048 = timeRays(2048, 5);

  console.log('diff_killfield_field PASS：逆杀戮场在我们的迷宫上跑通；' +
    '可达格=' + view.reachable.length + ' 墙格=' + view.walls.length + '；' +
    '敌人格票数=' + field.countAt(enemy) + '（非最佳射击格，max=' + field.maxCount + '）；视线格票数=' + field.countAt(los) + '；' +
    '瞄准误差=' + (dA * 180 / Math.PI).toFixed(1) + '°；' +
    '镜像最大差=' + maxDiff + '；' +
    '耗时（预热后）：512 射线 ' + msWarm512.toFixed(2) + 'ms / 1024 射线 ' + msWarm1024.toFixed(2) +
    'ms / 2048 射线 ' + ms2048.toFixed(2) + 'ms（冷启动 ' + ms512.toFixed(1) + 'ms）');
}

main().catch(function (e) {
  console.error('diff_killfield_field FAIL: ' + (e && e.stack || e));
  process.exit(1);
});
