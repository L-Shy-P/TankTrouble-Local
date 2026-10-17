'use strict';
/* 多路并行实测 —— 回答"并行能不能无损提升吞吐"（用户提的需求）
 *
 *   node _tools/headless/parallel_bench.js --n 4 --steps 20
 *
 * 每个 Match = 独立浏览器进程 + 独立 Python 服务器 + 独立物理世界 → 零干扰。
 * 测：N 路并行时，聚合吞吐是不是线性的。
 */
const { Match } = require('./match');

function arg(n, d) { const i = process.argv.indexOf('--' + n); return i < 0 ? d : Number(process.argv[i + 1]); }
const TILE = 10;

async function oneEnv(id, STEPS, PUMP_CHUNK, barrierStart, onProgress) {
  const t0 = Date.now();
  const m = new Match();
  const out = { id, ok: false };
  try {
    await m.open({ humanIds: ['tank_a'], aiCount: 0, vantCount: 1 });
    await m.clearControl();
    let started = false;
    for (let i = 0; i < 30; i++) {
      const a = await m.myTank(); if (!a) break;
      await m.setControl({ fwd: true }); await m.pump(8, { yieldMs: 4 });
      const b = await m.myTank();
      if (b && Math.hypot(b.x - a.x, b.y - a.y) > 0.5) { started = true; break; }
    }
    await m.clearControl();
    if (!started) { out.err = '回合没起来'; return out; }

    await m.eval(`window.__vtStep1 = function (c, f, tx, ty) {
      var g = window.__vtCtrl; g.fwd=!!c.fwd; g.back=!!c.back; g.left=!!c.left; g.right=!!c.right;
      window.__vtStep(f);
      var gc = GameManager.getGameController(); var t = gc && gc.getTank(window.__vtTankId);
      if (!t) return null;
      var x=t.getX(), y=t.getY(), dx=x-tx, dy=y-ty;
      return { x:x, y:y, rot:t.getRotation(), d: Math.sqrt(dx*dx+dy*dy)/${TILE} }; }`);
    await m.eval(`window.__vtSet = function (x,y,r) { var gc=GameManager.getGameController();
      gc.setTankState(TankState.withState(window.__vtTankId,x,y,false,false,r,false,false,false,false),false); return 1; }`);
    const mz = await m.maze();
    const cand = mz.reachable.map((r) => ({ x: r.x * TILE + TILE / 2, y: r.y * TILE + TILE / 2 }));

    out.readyMs = Date.now() - t0;
    await barrierStart;                      // ★ 所有环境就绪后才开始计时 —— 只计「跑」的时间
    const tRun = Date.now();
    let steps = 0;
    for (let ep = 0; ep < 6; ep++) {
      const A = cand[(Math.random() * cand.length) | 0];
      const B = cand[(Math.random() * cand.length) | 0];
      await m.eval(`window.__vtSet(${A.x}, ${A.y}, 0.5)`);
      let cur = await m.myTank();
      if (!cur) continue;
      for (let t = 0; t < STEPS; t++) {
        const k = 1 + ((Math.random() * 8) | 0);
        const o = [null, { fwd: 1 }, { back: 1 }, { left: 1 }, { right: 1 },
          { fwd: 1, left: 1 }, { fwd: 1, right: 1 }, { back: 1, left: 1 }, { back: 1, right: 1 }][k];
        const nxt = await m.eval(`window.__vtStep1(${JSON.stringify(o)}, ${PUMP_CHUNK}, ${B.x}, ${B.y})`);
        if (!nxt) break;
        steps++;
        cur = nxt;
      }
    }
    out.runMs = Date.now() - tRun;
    out.steps = steps;
    out.stepsPerSec = +(steps / (out.runMs / 1000)).toFixed(1);
    out.ok = true;
    return out;
  } catch (e) {
    out.err = String((e && e.message) || e).slice(0, 200);
    return out;
  } finally { await m.close(); }
}

(async () => {
  const N = arg('n', 4);
  const STEPS = arg('steps', 20);
  const PUMP_CHUNK = arg('seg', 13);   // ⚠️ 脚本参数、非设计参数
  const t0 = Date.now();
  console.log(`启动 ${N} 路并行环境…`);

  let release;
  const barrier = new Promise((r) => { release = r; });
  // 全部就绪后统一放行
  const tasks = [];
  for (let i = 0; i < N; i++) tasks.push(oneEnv(i, STEPS, PUMP_CHUNK, barrier));
  // 等所有 ready 后放行（用轮询 readyMs 不可靠，改成固定延迟后放行）
  setTimeout(() => release(), 6000 + N * 1500);

  const res = await Promise.all(tasks);
  console.log('\n===== 并行结果 =====');
  let totalSteps = 0, maxRun = 0, okN = 0;
  for (const r of res) {
    if (r.ok) { okN++; totalSteps += r.steps; maxRun = Math.max(maxRun, r.runMs); }
    console.log(`  env${r.id}  ${r.ok ? 'OK' : 'FAIL ' + r.err}  就绪 ${r.readyMs}ms  跑 ${r.runMs}ms  ` +
      `${r.steps} 步  ${r.stepsPerSec} 步/秒`);
  }
  console.log(`\n  成功 ${okN}/${N} 路`);
  console.log(`  聚合: ${totalSteps} 步 / ${(maxRun / 1000).toFixed(1)}s = ${(totalSteps / (maxRun / 1000)).toFixed(1)} 步/秒`);
  console.log(`  单路基线约 45 步/秒（600帧/秒 ÷ 13帧/步）；理论线性 ${N}×45 = ${N * 45} 步/秒`);
  console.log(`  线性度: ${((totalSteps / (maxRun / 1000)) / (N * 45) * 100).toFixed(0)}%`);
  console.log(`  总用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
})();
