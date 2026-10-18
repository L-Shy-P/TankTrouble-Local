#!/usr/bin/env node
// 探针（不修、只记档）：坦克完全贴墙时 JS 融合 vs wasm Rust 的位姿分叉。
// 现象：tank.x = 墙内表面 0.4 + 半宽 1.5 = 1.9（零间隙），第 1~2 帧被位置
// 求解器推开的量两边不同（量级 1e-3 ~ 1e-5 m）。只打印数据，不做 PASS/FAIL。
'use strict';
const H = require('./_diff_proj_semantics_harness.js');

function diff(js, rust) {
  const a = js[0].samples, b = rust[0].samples;
  let maxD = 0, at = -1;
  for (let k = 0; k < a.length; k++) {
    const d = Math.hypot(a[k].x - b[k].x, a[k].y - b[k].y);
    if (d > maxD) { maxD = d; at = k; }
  }
  return { a: a, b: b, maxD: maxD, at: at };
}

async function runCase(label, x, y, rot, w, h, calls, ins) {
  const S = H.loadSandbox();
  const Box2D = S.Box2D, Constants = S.Constants, VB = S.VantageSandbox;
  void Constants;
  VB.setFrameDtSec(1 / 60);
  const maze = H.makeMaze(w, h);
  const tank = H.makeFakeTank(Box2D, x, y, rot);
  const gc = H.makeGameController(maze, tank, {});
  const adapter = VB.createAdapter(gc, 'p0');
  const pose = { x: x, y: y, rot: rot };
  if (!ins) ins = { forward: false, back: false, left: false, right: false };
  const ops = []; for (let i = 0; i < 9; i++) ops.push({ name: label, inputs: ins });
  VB.setRustPhysicsEnabled(false);
  let js = null;
  for (let c = 0; c < calls; c++) js = adapter.simulateTankBatch(pose, ops, 75, { startPose: pose, threats: [], tGlobal: 0 });
  await H.initRust(S);
  VB.setRustPhysicsEnabled(true);
  let rust = null;
  for (let c = 0; c < calls; c++) rust = adapter.simulateTankBatch(pose, ops, 75, { startPose: pose, threats: [], tGlobal: 0 });
  const d = diff(js, rust);
  console.log('[' + label + '] 起点=(' + x + ',' + y + ') rot=' + rot.toFixed(3) + ' 迷宫' + w + 'x' + h +
    ' 第' + calls + '次调用: max|dp|=' + d.maxD.toExponential(3) + ' m @k=' + d.at +
    '  k1 JS=(' + d.a[1].x.toFixed(6) + ',' + d.a[1].y.toFixed(6) + ') Rust=(' + d.b[1].x.toFixed(6) + ',' + d.b[1].y.toFixed(6) + ')' +
    '  k2 JS=(' + d.a[2].x.toFixed(6) + ',' + d.a[2].y.toFixed(6) + ') Rust=(' + d.b[2].x.toFixed(6) + ',' + d.b[2].y.toFixed(6) + ')');
  return d;
}

(async () => {
  console.log('=== 贴墙工况 JS↔Rust 分叉探针：左墙内表面 x=0.4，车半宽 1.5 / 半高 2.0 ===');
  console.log('\n-- A. 静止，rot=0（车宽方向贴左墙 x=1.9）--');
  await runCase('静止贴左墙', 1.9, 5, 0, 4, 4, 1);
  console.log('\n-- B. 静止，rot=0，角点 (x=1.9, y=2.4 车高方向贴下墙) --');
  await runCase('角点贴平', 1.9, 2.4, 0, 4, 4, 1);
  console.log('\n-- C. 第二次调用（融合世界 warm-start 残留）--');
  await runCase('左墙 k2', 1.9, 5, 0, 4, 4, 2);
  await runCase('角点 k2', 1.9, 2.4, 0, 4, 4, 2);
  console.log('\n-- D. 不同迷宫尺寸 --');
  await runCase('左墙 4x3', 1.9, 5, 0, 4, 3, 1);
  await runCase('左墙 3x4', 1.9, 5, 0, 3, 4, 1);
  console.log('\n-- E. 反例（不是“完全贴墙”，而是车体旋转 90° 后嵌进墙 0.5m；仅供对照）--');
  await runCase('rot=-90 嵌入0.5m', 1.9, 5, -Math.PI / 2, 4, 4, 1);
  console.log('\n-- F. 贴墙滑行 / 转向（真实树里“蹭墙”的常见操作）--');
  await runCase('贴左墙前进(滑行)', 1.9, 5, 0, 4, 4, 1, { forward: true, back: false, left: false, right: false });
  await runCase('贴左墙前进+右转', 1.9, 5, 0, 4, 4, 1, { forward: true, back: false, left: false, right: true });
  await runCase('贴左墙前进+左转', 1.9, 5, 0, 4, 4, 1, { forward: true, back: false, left: true, right: false });
  await runCase('原地右转', 1.9, 5, 0, 4, 4, 1, { forward: false, back: false, left: false, right: true });
})().catch((e) => { console.error('probe error:', (e && e.stack) || e); process.exit(1); });
