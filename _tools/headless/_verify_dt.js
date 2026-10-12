const { Match } = require('./match');
const TILE = 10;
(async () => {
  const m = new Match();
  try {
    await m.open({ humanIds:['tank_a','tank_b'], aiCount:0, vantCount:0 });
    await m.clearControl();
    let started=false;
    for (let i=0;i<30;i++){ const a=await m.myTank(); if(!a)break;
      await m.setControl({fwd:true}); await m.pump(8,{yieldMs:4});
      const b=await m.myTank(); if(b&&Math.hypot(b.x-a.x,b.y-a.y)>0.5){started=true;break;} }
    await m.clearControl();
    console.log('回合开始:', started);
    const mz = await m.maze();
    const cand = mz.reachable.map(r=>({x:r.x*TILE+5,y:r.y*TILE+5}));

    // 找一个前方开阔的点：多试几个
    console.log('\n=== 紧循环同步 __vtStep：向左转（不受墙影响，最能验证 dt）===');
    for (const rot of [0.3, 1.0, 2.0]) {
      const A = cand[0];
      await m.teleport('tank_a', A.x, A.y, rot);
      await m.pump(6,{yieldMs:4});
      const a0 = await m.myTank();
      const t0 = Date.now();
      await m.eval("window.__vtCtrl.left=true");
      await m.eval("window.__vtStep(30)");     // ★ 一次性紧循环
      await m.eval("window.__vtCtrl.left=false");
      const a1 = await m.myTank();
      const dt = Date.now() - t0;
      const drot = a1.rot - a0.rot;
      console.log(`  rot ${rot}  30帧左转 Δrot=${drot.toFixed(4)}  (理论 ${(30/60*5).toFixed(4)}=5rad/s×0.5s)  用时${dt}ms`);
    }

    console.log('\n=== 紧循环同步 __vtStep：前进（可能撞墙，看最大值）===');
    let best = 0;
    for (let k = 0; k < 6; k++) {
      const A = cand[(k*3) % cand.length];
      for (const rot of [0, 1.57, 3.14, 4.71]) {
        await m.teleport('tank_a', A.x, A.y, rot);
        await m.pump(4,{yieldMs:3});
        const a0 = await m.myTank();
        if (!a0) continue;
        await m.eval("window.__vtCtrl.fwd=true");
        await m.eval("window.__vtStep(20)");
        await m.eval("window.__vtCtrl.fwd=false");
        const a1 = await m.myTank();
        if (!a1) continue;
        const mv = Math.hypot(a1.x-a0.x, a1.y-a0.y);
        if (mv > best) best = mv;
      }
    }
    console.log(`  20 帧前进最大位移 ${best.toFixed(2)}  (理论 ${(20/60*15.95).toFixed(2)}=15.95单位/s×0.333s)`);
    console.log('\n  判定:', best > 4 ? '✅ 虚拟时钟已接管物理 dt' : '❌ 还是不对');
  } catch(e){ console.error('FAILED:', (e&&e.stack)||e); }
  finally { await m.close(); }
})();
