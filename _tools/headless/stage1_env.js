'use strict';
/* 阶段 1′ 环境：移动任务
 *
 * 任务（文档原文）：「地图上随机给可达位姿，尽可能短时间内贴合」
 *
 * 关键设计：训练时【策略跑在 Node/Python 侧】，靠 CDP 驱动浏览器。
 *   - 不需要在 JS 里实现 Transformer（部署时再导出）
 *   - 每个决策段（13 帧）才需要一次往返，CDP 单次 ~1-3ms，完全负担得起
 *   - 奖励直接来自迷宫的 getDistancesFromPosition（免费的距离场）
 *
 * 用法：node _tools/headless/stage1_env.js [--episodes 5]
 */
const { Match } = require('./match');

const OPS = [
  { n: '静止',   fwd: 0, back: 0, left: 0, right: 0 },
  { n: '前',     fwd: 1, back: 0, left: 0, right: 0 },
  { n: '后',     fwd: 0, back: 1, left: 0, right: 0 },
  { n: '左',     fwd: 0, back: 0, left: 1, right: 0 },
  { n: '右',     fwd: 0, back: 0, left: 0, right: 1 },
  { n: '前左',   fwd: 1, back: 0, left: 1, right: 0 },
  { n: '前右',   fwd: 1, back: 0, left: 0, right: 1 },
  { n: '后左',   fwd: 0, back: 1, left: 1, right: 0 },
  { n: '后右',   fwd: 0, back: 1, left: 0, right: 1 },
];
const TILE = 10;          // MAZE_TILE_SIZE.m

function arg(n, d) { const i = process.argv.indexOf('--' + n); return i < 0 ? d : Number(process.argv[i + 1]); }

(async () => {
  const EPISODES = arg('episodes', 5);
  const SEG = arg('seg', 13);
  const t0 = Date.now();
  const T = () => ((Date.now() - t0) / 1000).toFixed(1) + 's';

  const m = new Match();
  try {
    // 无对手（阶段 1′ 不需要），但要有第二个玩家才能开局
    await m.open({ humanIds: ['tank_a'], aiCount: 0, vantCount: 1 });
    console.log(`[${T()}] 开局:`, JSON.stringify(m.bootstrap));

    const maze = await m.maze();
    console.log(`[${T()}] 迷宫 ${maze.width}x${maze.height}  可达 ${maze.reachable.length} 格`);

    // ★ 自适应等回合开始：倒计时期间 setInputState 会被游戏直接丢弃
    await m.clearControl();
    let started = false;
    for (let i = 0; i < 30; i++) {
      const p0 = await m.myTank();
      if (!p0) break;
      await m.setControl({ fwd: true });
      await m.pump(8, { yieldMs: 4 });
      const p1 = await m.myTank();
      if (p1 && Math.hypot(p1.x - p0.x, p1.y - p0.y) > 0.5) { started = true; break; }
    }
    await m.clearControl();
    console.log(`[${T()}] 回合已开始: ${started}`);
    if (!started) throw new Error('回合没起来，输入被丢弃');

    // 装好「按瓦片坐标求距离」的辅助（迷宫 API 要瓦片坐标，坦克坐标是像素）
    await m.eval(`window.__vtTileDist = function (ax, ay, bx, by) {
      var mz = GameManager.getGameController().getMaze();
      var d = mz.getDistanceBetweenPositions({x: Math.floor(ax/${TILE}), y: Math.floor(ay/${TILE})},
                                             {x: Math.floor(bx/${TILE}), y: Math.floor(by/${TILE})});
      return d === false ? null : d;
    }`);

    const results = [];
    for (let ep = 0; ep < EPISODES; ep++) {
      const epT = Date.now();
      // 1) 找一个合法的起始位姿（用可达格位）
      // ★ reachable 给的是【瓦片坐标】(0..w-1)，坦克坐标是【像素】= 瓦片*10 + 5（格心）
      const cand = maze.reachable
        .filter((r) => r && typeof r.x === 'number' && typeof r.y === 'number')
        .map((r) => ({ x: r.x * TILE + TILE / 2, y: r.y * TILE + TILE / 2 }));
      if (cand.length < 2) { console.log('可达格位不足，跳过'); break; }
      const pickA = cand[Math.floor(Math.random() * cand.length)];
      const pickB = cand[Math.floor(Math.random() * cand.length)];

      await m.teleport('tank_a', pickA.x, pickA.y, 0);
      await m.pump(6, { yieldMs: 4 });          // 让引擎矫正位姿
      const s0 = await m.myTank();
      if (!s0) { console.log('传送后拿不到坦克，跳过'); continue; }

      const target = { x: pickB.x, y: pickB.y };
      const d0 = await m.eval(`window.__vtTileDist(${s0.x}, ${s0.y}, ${target.x}, ${target.y})`);

      // 2) 跑一段随机策略，看能不能缩短距离
      const traj = [];
      let cur = s0;
      for (let step = 0; step < 4; step++) {
        const op = 1 + Math.floor(Math.random() * 8);   // 不用「静止」
        const o = OPS[op];
        await m.setControl({ fwd: !!o.fwd, back: !!o.back, left: !!o.left, right: !!o.right });
        await m.pump(SEG, { yieldMs: 0 });
        await m.clearControl();
        const now = await m.myTank();
        if (!now) break;
        const dNow = await m.eval(`window.__vtTileDist(${now.x}, ${now.y}, ${target.x}, ${target.y})`);
        traj.push({ op: o.n, d: dNow });
        cur = now;
      }
      const d1 = await m.eval(`window.__vtTileDist(${cur.x}, ${cur.y}, ${target.x}, ${target.y})`);
      results.push({
        ep, 起点: [s0.x, s0.y], 目标: [target.x, target.y],
        起始距离: d0, 结束距离: d1, 位移: +Math.hypot(cur.x - s0.x, cur.y - s0.y).toFixed(1),
        轨迹: traj, 用时ms: Date.now() - epT,
      });
    }

    console.log(`\n===== 阶段 1′ 环境验证（${results.length} 局）=====`);
    for (const r of results) {
      const ok = r.起始距离 !== null && r.结束距离 !== null;
      const 改善 = ok ? (r.起始距离 - r.结束距离) : null;
      console.log(`  局${r.ep}  起点(${r.起点[0]},${r.起点[1]}) → 目标(${r.目标[0]},${r.目标[1]})  ` +
        `距离 ${r.起始距离} → ${r.结束距离}  (${改善 === null ? '?' : (改善 > 0 ? '近 ' + 改善 : '远 ' + (-改善))})  ` +
        `位移 ${r.位移}  ${r.用时ms}ms`);
    }
    const valid = results.filter((r) => r.起始距离 !== null && r.结束距离 !== null);
    console.log(`\n  有效局数 ${valid.length}/${results.length}`);
    console.log(`  距离场可用: ${valid.length > 0 ? '✅' : '❌'}`);
    console.log(`  每局平均用时 ${(results.reduce((a, r) => a + r.用时ms, 0) / Math.max(results.length, 1)).toFixed(0)} ms`);
    console.log(`  吞吐 ≈ ${(1000 / (results.reduce((a, r) => a + r.用时ms, 0) / Math.max(results.length, 1))).toFixed(1)} 局/秒`);
    console.log(`\n  总用时 ${T()}`);
    console.log(`  vtErrors: ${JSON.stringify((await m.stats()).errors.slice(0, 2))}`);
    console.log(`\n样例轨迹: ${JSON.stringify(results[0] && results[0].轨迹)}`);
  } catch (e) {
    console.error('FAILED:', (e && e.stack) || e);
    process.exitCode = 1;
  } finally { await m.close(); }
})();
