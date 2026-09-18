#!/usr/bin/env node
// Killfield 移植 · 第二步回归：来袭风险（risk.js）在我们的视图/单位下是否讲道理。
'use strict';
const path = require('path');
const assert = require('assert');
const { pathToFileURL } = require('url');
const dir = path.resolve(__dirname, '..', 'external_ai', 'killfield');
const TILE = 10, DT = 0.02;

async function main() {
  const C = await import(pathToFileURL(path.join(dir, 'constants.js')).href);
  const { buildCombatView } = await import(pathToFileURL(path.join(dir, 'gameView.js')).href);
  const { incomingRisk, reflectiveClosest } = await import(pathToFileURL(path.join(dir, 'risk.js')).href);

  // 12x10 空房间（只有外墙）+ 一堵内墙用来测反弹
  const W = 12, H = 10;
  const wallTile = (x, y) => (x <= 0 || y <= 0 || x >= W - 1 || y >= H - 1);
  const boxes = [];
  for (let x = 0; x < W; x++) for (let y = 0; y < H; y++) {
    if (wallTile(x, y)) boxes.push([x * TILE, y * TILE, (x + 1) * TILE, (y + 1) * TILE]);
  }

  const me = { x: 8.5 * TILE, y: 3.5 * TILE, rot: 0, alive: true };
  const enemy = { x: 2.5 * TILE, y: 7.5 * TILE, rot: 0, alive: true };
  function view(bullets) {
    return buildCombatView({ me: me, enemy: enemy, bullets: bullets, scale: TILE, dt: DT });
  }
  // 我们的弹速 20 米/秒 = 0.4 米/帧
  const SPEED = 20;

  // ① 正对我飞来（同一行，朝 -x）→ 风险应当很高
  // 风险口径（他们算法）：urgency = 1 − 到达帧/视野帧，视野 = 1.2 秒 × 20 米/秒 = 24 米 = 2.4 格。
  // 所以 0.5 格外（5 米 = 12.5 帧）应当得到 1 − 12.5/60 ≈ 0.79。
  const atMe = view([{ x: me.x + 0.5 * TILE, y: me.y, vx: -SPEED, vy: 0, lifeLeft: 3 }]);
  const riskAtMe = incomingRisk(atMe, boxes);
  assert(riskAtMe > 0.6, '近距正对我的子弹风险应当很高，实际 ' + riskAtMe);
  // 视野边缘（2.3 格 = 23 米 ≈ 57.5 帧）应当只有一点点风险，而 2.5 格外应当为 0
  const edge = view([{ x: me.x + 2.3 * TILE, y: me.y, vx: -SPEED, vy: 0, lifeLeft: 3 }]);
  const beyond = view([{ x: me.x + 2.5 * TILE, y: me.y, vx: -SPEED, vy: 0, lifeLeft: 3 }]);
  const rEdge = incomingRisk(edge, boxes), rBeyond = incomingRisk(beyond, boxes);
  assert(rEdge > 0 && rEdge < 0.2, '视野边缘应当只有一点点风险，实际 ' + rEdge);
  assert.strictEqual(rBeyond, 0, '视野外（2.5 格）必须为 0，实际 ' + rBeyond);

  // ② 背对我飞走 → 0
  const away = view([{ x: me.x + 1.5 * TILE, y: me.y, vx: SPEED, vy: 0, lifeLeft: 3 }]);
  assert.strictEqual(incomingRisk(away, boxes), 0, '飞走的子弹风险必须是 0');

  // ③ 平行飞过（差 2 格）→ 0
  const parallel = view([{ x: me.x + 1.5 * TILE, y: me.y + 1 * TILE, vx: -SPEED, vy: 0, lifeLeft: 3 }]);
  assert.strictEqual(incomingRisk(parallel, boxes), 0, '从旁边飞过的子弹风险必须是 0');

  // ④ 越近越急：同一方向、距离更近的子弹风险不低于远的
  const near = view([{ x: me.x + 1 * TILE, y: me.y, vx: -SPEED, vy: 0, lifeLeft: 3 }]);
  const far = view([{ x: me.x + 2 * TILE, y: me.y, vx: -SPEED, vy: 0, lifeLeft: 3 }]);
  const rNear = incomingRisk(near, boxes), rFar = incomingRisk(far, boxes);
  assert(rNear >= rFar, '近的应当更急（' + rNear + ' vs ' + rFar + '）');

  // ⑤ 反弹后打到我：子弹先朝墙飞，反弹回来对准我
  //    内墙 x=4 在 y=3..5，我在 (8.5,3.5)：子弹放在内墙左侧朝 -x 飞不会回来；
  //    换成放在我右侧朝 +x 飞、由右墙反弹回来 —— 用 reflectiveClosest 直接验几何。
  //    造一面贴着我右侧 5 米的墙（我们的墙是整格 → 拿格 (9,3) 当墙），
  //    子弹放在我和墙之间朝墙飞：反弹回来应当正好打到我。
  const nearWall = boxes.concat([[9 * TILE, 3 * TILE, 10 * TILE, 4 * TILE]]);
  const hitAfterBounce = reflectiveClosest(
    me.x + 3, me.y, 1, 0, SPEED * DT, C.FPS * 3, 3, nearWall, me.x, me.y);
  assert(hitAfterBounce.distance < 0.6,
    '朝近墙打出去应当反弹回来打到我，最近距离 ' + hitAfterBounce.distance);
  assert(hitAfterBounce.bounces >= 1, '应当至少反弹一次，实际 ' + hitAfterBounce.bounces);
  // 同一发子弹在我们的 risk 视图里也该报警
  const bounceRisk = incomingRisk(view([{ x: me.x + 3, y: me.y, vx: SPEED, vy: 0, lifeLeft: 3 }]), nearWall);
  assert(bounceRisk > 0, '反弹后会打到我的子弹，风险应当 > 0（实际 ' + bounceRisk + '）');

  // ⑥ 正射线自检：距离≈0、到达帧≈距离/每帧速度
  const straight = reflectiveClosest(me.x + 3 * TILE, me.y, -1, 0, SPEED * DT, 150, 3, boxes, me.x, me.y);
  assert(straight.distance < 1e-6, '正对目标的射线最近距离应当≈0，实际 ' + straight.distance);
  const expectFrame = (3 * TILE) / (SPEED * DT);
  assert(Math.abs(straight.frame - expectFrame) < 1.5,
    '到达帧应当≈' + expectFrame.toFixed(1) + '，实际 ' + straight.frame.toFixed(1));

  // ⑦ 口径自检：3 秒射程 = 6 格（他们"三秒内到的子弹才投票"）
  assert(Math.abs((SPEED * DT * 3 * C.FPS) / TILE - 6) < 0.01,
    '3 秒应当飞 6 格，实际 ' + (SPEED * DT * 3 * C.FPS / TILE).toFixed(2));

  // 计时：10 颗子弹
  const many = [];
  for (let i = 0; i < 10; i++) many.push({ x: me.x + (2 + i) * TILE, y: me.y + (i % 3), vx: -SPEED, vy: 0, lifeLeft: 3 });
  const v10 = view(many);
  for (let i = 0; i < 5; i++) incomingRisk(v10, boxes);      // 预热
  const t0 = process.hrtime.bigint();
  const N = 200;
  for (let i = 0; i < N; i++) incomingRisk(v10, boxes);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6 / N;

  console.log('diff_killfield_risk PASS：近正对=' + riskAtMe.toFixed(2) + ' 视野边缘=' + rEdge.toFixed(2) + ' 视野外=' + rBeyond +
    ' 飞走=' + incomingRisk(away, boxes) +
    ' 斜过=' + incomingRisk(parallel, boxes) +
    ' 近=' + rNear.toFixed(2) + '/远=' + rFar.toFixed(2) +
    '；反弹命中距离=' + hitAfterBounce.distance.toFixed(2) + ' 反弹风险=' + bounceRisk.toFixed(2) +
    '；10 颗弹一次=' + ms.toFixed(3) + 'ms');
}

main().catch(function (e) { console.error('diff_killfield_risk FAIL: ' + (e && e.stack || e)); process.exit(1); });
