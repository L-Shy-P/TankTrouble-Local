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
    const mz = await m.maze();
    const cand = mz.reachable.map(r=>({x:r.x*TILE+5,y:r.y*TILE+5}));
    const A = cand[0];
    console.log('回合开始:', started);

    await m.eval(`
      window.__vtT = async function (seg, frames, every, ms) {
        var c = window.__vtCtrl; c.fwd = true; c.back = c.left = c.right = false;
        var t0 = performance.now();
        for (var s = 0; s < seg; s++) {
          for (var f = 0; f < frames; f++) {
            window.__vtStep(1);
            if (every > 0 && f % every === 0) await new Promise(function(r){ setTimeout(r, ms); });
          }
        }
        var gc = GameManager.getGameController();
        var t = gc.getTank(window.__vtTankId);
        return { x: t.getX(), y: t.getY() };
      };
      window.__vtT2 = async function () {   // 对照：完全不 await
        var c = window.__vtCtrl; c.fwd = true; c.back = c.left = c.right = false;
        return 1;
      };
    `);

    console.log('\n每段16帧 × 4段（理论位移 17，纯前进）');
    for (const [every, ms] of [[1,0],[2,0],[4,0],[8,0],[16,0],[4,2],[1,2]]) {
      await m.teleport('tank_a', A.x, A.y, 1.5);
      await m.pump(6,{yieldMs:4});
      const a0 = await m.myTank();
      const t0 = Date.now();
      const r = await m.eval(`window.__vtT(4, 16, ${every}, ${ms})`, { awaitPromise: true });
      const dt = Date.now() - t0;
      const mv = (r && a0) ? Math.hypot(r.x-a0.x, r.y-a0.y) : -1;
      console.log(`  每 ${String(every).padStart(2)} 帧 await 一次, sleep ${ms}ms  →  位移 ${mv.toFixed(2).padStart(6)}   ${String(dt).padStart(5)}ms   ${(64/(dt/1000)).toFixed(0).padStart(4)} 帧/秒`);
    }
  } catch(e){ console.error('FAILED:', (e&&e.stack)||e); }
  finally { await m.close(); }
})();
