'use strict';
/* #8 实验（主人 2026-10-10 指派）：炮口死死顶住墙壁发射，能否 0 帧自杀？
 *
 * 方法：把 tank_a 朝墙开直到推不动（真物理贴墙），然后只按 1 帧 fire，
 * 逐帧记录子弹轨迹 + 坦克存亡，测「开火后第几帧死」。
 * 死亡帧 ≤ 1 才算「0 帧自杀」（坦克还没开始动就死了）。
 * 对照：同一位置朝开阔方向射，应不死。
 *
 *   node _tools/headless/_probe_wall_suicide.js
 */
const { Match } = require('./match');
const TILE = 10;

const DIRS = [
  { dx: 1, dy: 0, rot: Math.PI / 2, name: '+x' },
  { dx: -1, dy: 0, rot: -Math.PI / 2, name: '-x' },
  { dx: 0, dy: 1, rot: Math.PI, name: '+y' },
  { dx: 0, dy: -1, rot: 0, name: '-y' },
];

const SNAP = `(() => {
  var gc = GameManager.getGameController();
  var d = __vtData(gc.getRoundState()) || {};
  var t = gc.getTank('tank_a');
  return {
    alive: !!t,
    x: t ? +t.getX().toFixed(2) : null,
    y: t ? +t.getY().toFixed(2) : null,
    projs: (d.projectileStates || []).map(function (p) {
      return { o: p.playerId, x: +p.x.toFixed(2), y: +p.y.toFixed(2), rot: +(+p.rotation).toFixed(2), type: p.type };
    }),
    roundId: gc.getRoundId ? gc.getRoundId() : -1,
  };
})()`;

/** 怼墙后单发实验；返回 {deathFrame, log} */
async function tryWallShot(m, spot, open, farCell) {
  const cx = spot.r.x * TILE + TILE / 2, cy = spot.r.y * TILE + TILE / 2;
  await m.teleport('tank_b', farCell.x * TILE + 5, farCell.y * TILE + 5, 0);
  await m.teleport('tank_a', cx, cy, spot.d.rot);
  await m.pump(8, { yieldMs: 2 });

  // 怼墙：朝墙开，直到连续 3 帧位置不动
  await m.setControl({ fwd: true });
  let last = null, still = 0;
  for (let i = 0; i < 60; i++) {
    await m.pump(1, { yieldMs: 0 });
    const t = await m.myTank();
    if (last && Math.hypot(t.x - last.x, t.y - last.y) < 0.01) { if (++still >= 3) break; }
    else still = 0;
    last = t;
  }
  await m.clearControl();
  await m.pump(3, { yieldMs: 0 });
  const pressed = await m.myTank();
  const moved = Math.hypot(pressed.x - cx, pressed.y - cy);

  // 开火：只按 1 帧
  await m.setControl({ fire: true });
  await m.pump(1, { yieldMs: 0 });
  await m.setControl({ fire: false });

  const log = [];
  let deathFrame = -1;
  for (let i = 0; i <= 60; i++) {
    const s = await m.eval(SNAP);
    const pj = s.projs.map((p) => `(${p.x},${p.y})`).join(' ');
    if (i <= 16 || !s.alive) log.push(`  f${i}: alive=${s.alive} tank=(${s.x},${s.y}) 弹=${s.projs.length} ${pj}`);
    if (!s.alive) { deathFrame = i; break; }
    await m.pump(1, { yieldMs: 0 });
  }
  return { deathFrame, moved, pressed, log };
}

(async () => {
  const m = new Match();
  try {
    await m.open({ humanIds: ['tank_a', 'tank_b'], aiCount: 0, vantCount: 0 });
    await m.clearControl();
    const mz = await m.maze();
    const key = (x, y) => x + ',' + y;
    const open = new Set(mz.reachable.map((r) => key(r.x, r.y)));
    console.log(`迷宫 ${mz.width}x${mz.height} 可达 ${mz.reachable.length} 格`);

    // 候选：每个方向各取一个「该方向相邻格不可达」的可达格
    const spots = [];
    for (const d of DIRS) {
      const hit = mz.reachable.find((r) => !open.has(key(r.x + d.dx, r.y + d.dy)));
      if (hit) spots.push({ r: hit, d });
    }
    // tank_b 的远处停车位（离第一个实验点最远）
    const farOf = (s) => mz.reachable.reduce((best, r) => {
      const dd = (r.x - s.r.x) ** 2 + (r.y - s.r.y) ** 2;
      return dd > best.dd ? { r, dd } : best;
    }, { r: mz.reachable[0], dd: -1 }).r;

    let anyDeath = -1;
    for (const spot of spots) {
      console.log(`\n=== 实验：格(${spot.r.x},${spot.r.y}) 朝 ${spot.d.name} 顶墙 ===`);
      const res = await tryWallShot(m, spot, open, farOf(spot));
      console.log(`  怼墙位移=${res.moved.toFixed(2)} 停点=(${res.pressed.x},${res.pressed.y}) rot=${res.pressed.rot}`);
      for (const line of res.log) console.log(line);
      if (res.deathFrame >= 0) {
        console.log(`  ✅ 致死：开火后第 ${res.deathFrame} 帧死 ${res.deathFrame <= 1 ? '（= 0 帧自杀！）' : '（>1 帧，不算 0 帧死）'}`);
        if (anyDeath < 0) anyDeath = res.deathFrame;
      } else {
        console.log('  ❌ 60 帧内未死亡');
      }
      // 若 tank_a 死了，回合可能已结束，后续实验无意义
      if (res.deathFrame >= 0) break;
    }

    // 对照：朝开阔方向射（若 tank_a 还活着）
    const aliveNow = await m.eval(SNAP);
    if (aliveNow.alive) {
      const spot = spots[0];
      const cx = spot.r.x * TILE + TILE / 2, cy = spot.r.y * TILE + TILE / 2;
      // 朝「有相邻可达格」的方向射
      const openDir = DIRS.find((d) => open.has(key(spot.r.x + d.dx, spot.r.y + d.dy)));
      if (openDir) {
        console.log(`\n=== 对照：同格朝开阔方向 ${openDir.name} 射 ===`);
        await m.teleport('tank_a', cx, cy, openDir.rot);
        await m.pump(8, { yieldMs: 2 });
        await m.setControl({ fire: true });
        await m.pump(1, { yieldMs: 0 });
        await m.setControl({ fire: false });
        let dead = -1;
        for (let i = 0; i <= 60; i++) {
          const s = await m.eval(SNAP);
          if (!s.alive) { dead = i; break; }
          await m.pump(1, { yieldMs: 0 });
        }
        console.log(dead >= 0 ? `  对照组也死了？第 ${dead} 帧（异常，需要查）` : '  ✅ 对照组 60 帧内存活（符合预期）');
      }
    }

    console.log('\n=== 总结论 ===');
    console.log(anyDeath < 0
      ? '顶墙发射【不会】0 帧自杀（60 帧内不死）⟹ 按主人裁决：无法 100% 确认的检测不做，#8 闭环'
      : `顶墙发射【能】致死，死亡帧 = ${anyDeath} ${anyDeath <= 1 ? '⟹ 0 帧自杀存在，检测值得做' : '⟹ 会死但不是 0 帧死（子弹要飞回来几帧）'}`);
    console.log('pageErrors:', JSON.stringify((await m.stats()).errors.slice(0, 3)));
  } catch (e) {
    console.error('FAILED:', (e && e.stack) || e);
    process.exitCode = 1;
  } finally { await m.close(); }
})();
