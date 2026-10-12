// 虚拟时钟修复验证：
//  1) new Date() / Date.now() / performance.now() / __vt.t 是否同步虚拟推进
//  2) 真实迷宫长走廊里 tight 循环（一次 evaluate）跑 60 帧，位移是否=15.95 单位
//  3) 原地转 30 帧，Δrot 是否=2.5 rad
//  4) random 策略 16 步 × 16 帧，逐步位移/路径长度（证明每步都在走）
const { Match } = require('./match');
const ACT = [{}, { fwd: 1 }, { back: 1 }, { left: 1 }, { right: 1 },
  { fwd: 1, left: 1 }, { fwd: 1, right: 1 }, { back: 1, left: 1 }, { back: 1, right: 1 }];

(async () => {
  const m = new Match();
  try {
    await m.open({ humanIds: ['tank_a', 'tank_b'], aiCount: 0, vantCount: 0 });
    await m.clearControl();
    let started = false;
    for (let i = 0; i < 30; i++) {
      const a = await m.myTank(); if (!a) break;
      await m.setControl({ fwd: true }); await m.pump(8, { yieldMs: 4 });
      const b = await m.myTank();
      if (b && Math.hypot(b.x - a.x, b.y - a.y) > 0.5) { started = true; break; }
    }
    await m.clearControl();
    console.log('回合开始:', started);

    // ---- 1) 时钟一致性 ----
    const t0 = await m.eval('({d:+new Date(), dn:Date.now(), p:performance.now(), t:window.__vt.t})');
    await m.eval('window.__vtStep(60)');
    const t1 = await m.eval('({d:+new Date(), dn:Date.now(), p:performance.now(), t:window.__vt.t})');
    console.log(`时钟推进 60 帧(应 1000ms): new Date Δ=${t1.d - t0.d}ms  Date.now Δ=${t1.dn - t0.dn}ms  ` +
      `performance.now Δ=${(t1.p - t0.p).toFixed(3)}ms  __vt.t Δ=${(t1.t - t0.t).toFixed(3)}ms`);

    // ---- 2) 找真正的长走廊（tiles[x][y][1]=topWall, [2]=leftWall，均为 0 表示可通行）----
    const maze = await m.eval(`(() => {
      var mz = GameManager.getGameController().getMaze();
      var d = mz.toObj ? mz.toObj() : mz.data;
      var tiles = d.tiles, W = tiles.length, H = tiles[0].length;
      var bestH = null; // 向右的长走廊
      for (var y = 0; y < H; y++) {
        for (var x = 0; x < W; x++) {
          if (tiles[x][y][0] !== 1) continue;
          var n = 0;
          while (x + n + 1 < W && tiles[x + n + 1][y][0] === 1 && tiles[x + n + 1][y][2] === 0) n++;
          if (!bestH || n > bestH.n) bestH = { x: x, y: y, n: n };
        }
      }
      var bestV = null; // 向上（-y）的长走廊
      for (var y = 0; y < H; y++) {
        for (var x = 0; x < W; x++) {
          if (tiles[x][y][0] !== 1) continue;
          var n = 0;
          while (y - n - 1 >= 0 && tiles[x][y - n - 1][0] === 1 && tiles[x][y - n][1] === 0) n++;
          if (!bestV || n > bestV.n) bestV = { x: x, y: y, n: n };
        }
      }
      return { bestH: bestH, bestV: bestV, W: W, H: H };
    })()`);
    console.log('迷宫', maze.W + 'x' + maze.H, '最长向右通道:', JSON.stringify(maze.bestH), '最长向上通道:', JSON.stringify(maze.bestV));

    const cx = maze.bestH.x * 10 + 5, cy = maze.bestH.y * 10 + 5;
    const ROT = Math.PI / 2; // forward=(sin,−cos)=(1,0) → +x
    async function reset() {
      await m.clearControl();
      await m.teleport('tank_a', cx, cy, ROT);
      await m.pump(4, { yieldMs: 4 });
    }

    await reset();
    let a = await m.myTank();
    await m.setControl({ fwd: 1 });
    await m.pump(60, { yieldMs: 0 });   // ★ 一次 evaluate，tight 循环
    await m.clearControl();
    let b = await m.myTank();
    console.log(`前进 60 帧 tight: 位移=${Math.hypot(b.x - a.x, b.y - a.y).toFixed(3)} 单位 ` +
      `(理论 ${(60 / 60 * 15.95).toFixed(3)})  pos(${a.x},${a.y})->(${b.x.toFixed(1)},${b.y.toFixed(1)})`);

    await reset();
    a = await m.myTank();
    await m.setControl({ fwd: 1 });
    await m.pump(240, { yieldMs: 0 });   // 4 秒虚拟时间，看撞墙前能走多远
    await m.clearControl();
    b = await m.myTank();
    console.log(`前进 240 帧 tight: 净位移=${Math.hypot(b.x - a.x, b.y - a.y).toFixed(3)} 单位 = ` +
      `${(Math.hypot(b.x - a.x, b.y - a.y) * 10).toFixed(1)} 像素  pos(${a.x},${a.y})->(${b.x.toFixed(1)},${b.y.toFixed(1)})`);

    await reset();
    a = await m.myTank();
    await m.setControl({ left: 1 });
    await m.pump(30, { yieldMs: 0 });
    await m.clearControl();
    b = await m.myTank();
    console.log(`左转 30 帧 tight: Δrot=${(b.rot - a.rot).toFixed(4)} rad (理论 ${(-5.0 * 0.5).toFixed(4)})`);

    // ---- 3) random 策略 16 步 × 16 帧 ----
    let sumPath = 0, steps = 0;
    for (let s = 0; s < 16; s++) {
      const before = await m.myTank();
      await m.setControl(ACT[(Math.random() * 9) | 0]);
      await m.pump(16, { yieldMs: 0 });
      await m.clearControl();
      const after = await m.myTank();
      const d = Math.hypot(after.x - before.x, after.y - before.y);
      sumPath += d; steps++;
      process.stdout.write(`${d.toFixed(2)} `);
    }
    console.log(`\nrandom 16步×16帧: 平均每步位移=${(sumPath / steps).toFixed(2)} 单位 = ${(sumPath / steps * 10).toFixed(1)} 像素`);
  } catch (e) { console.error('FAILED:', (e && e.stack) || e); process.exitCode = 1; }
  finally { await m.close(); }
})();
