// 临时诊断：模拟 rollout_worker 的 __vtSeg 流程，逐步记录位置
const { Match } = require('./match');
const ACT = [{}, { fwd: 1 }, { back: 1 }, { left: 1 }, { right: 1 },
  { fwd: 1, left: 1 }, { fwd: 1, right: 1 }, { back: 1, left: 1 }, { back: 1, right: 1 }];

(async () => {
  const m = new Match();
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
    console.log('回合开始:', started);

    const mz = await m.maze();
    const cand = mz.reachable.map((r) => ({ x: r.x * 10 + 5, y: r.y * 10 + 5 }));
    const PUMP_CHUNK = 13, STEPS = 8, NEP = 5;   // ⚠️ 同 stage1_env：脚本参数、非设计参数
    for (let ep = 0; ep < NEP; ep++) {
      const A = cand[(Math.random() * cand.length) | 0];
      await m.teleport('tank_a', A.x, A.y, Math.random() * 6.283);
      for (let z = 0; z < 3; z++) await m.pump(1, { yieldMs: 0 });
      const st0 = await m.myTank();
      let prev = st0, path = 0;
      const ds = [];
      for (let s = 0; s < STEPS; s++) {
        const a = (Math.random() * 9) | 0;
        const o = ACT[a];
        await m.setControl(o);
        await m.pump(PUMP_CHUNK, { yieldMs: 0 });
        await m.clearControl();
        const t = await m.myTank();
        const d = Math.hypot(t.x - prev.x, t.y - prev.y);
        path += d; ds.push(`a${a}:${d.toFixed(2)}`);
        prev = t;
      }
      const net = Math.hypot(prev.x - st0.x, prev.y - st0.y);
      console.log(`局${ep} 起点(${st0.x.toFixed(0)},${st0.y.toFixed(0)}) ${STEPS}步×${PUMP_CHUNK}帧: ` +
        `每步位移 [${ds.join(' ')}] 路径总长=${path.toFixed(1)} 净位移=${net.toFixed(1)} 像素`);
    }
    console.log('时钟:', JSON.stringify(await m.stats()));
  } catch (e) { console.error('FAILED:', (e && e.stack) || e); process.exitCode = 1; }
  finally { await m.close(); }
})();
