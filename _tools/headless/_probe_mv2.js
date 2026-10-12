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
    console.log('回合开始:', started, ' 测试点:', JSON.stringify(A));

    // ★ 页面内 async 版本：一次 CDP 调用，帧之间用 setTimeout 让出真实时间
    await m.eval(`
      window.__vtSegAsync = async function (ctrl, frames, ms) {
        var c = window.__vtCtrl;
        c.fwd=!!ctrl.fwd; c.back=!!ctrl.back; c.left=!!ctrl.left; c.right=!!ctrl.right;
        for (var f = 0; f < frames; f++) {
          window.__vtStep(1);
          await new Promise(function(r){ setTimeout(r, ms); });
        }
        var gc = GameManager.getGameController();
        var t = gc && gc.getTank(window.__vtTankId);
        if (!t) return null;
        return { x: t.getX(), y: t.getY(), rot: t.getRotation() };
      };
      window.__vtRunAsync = async function (nSeg, frames, ms, tx, ty) {
        var out = [];
        for (var s = 0; s < nSeg; s++) {
          var r = await window.__vtSegAsync({fwd:true}, frames, ms);
          if (r) out.push(r);
        }
        return out;
      };
    `);

    for (const ms of [0, 2, 4, 8]) {
      await m.teleport('tank_a', A.x, A.y, 1.5);
      await m.pump(6,{yieldMs:4});
      const a0 = await m.myTank();
      const t0 = Date.now();
      const res = await m.eval(`window.__vtRunAsync(4, 16, ${ms}, ${A.x}, ${A.y})`, { awaitPromise: true });
      const dt = Date.now() - t0;
      const last = res && res.length ? res[res.length-1] : null;
      const mv = last && a0 ? Math.hypot(last.x-a0.x, last.y-a0.y).toFixed(2) : '-';
      console.log(`  页面内 async, 每帧 sleep ${String(ms).padStart(2)}ms:  4段×16帧 位移 ${String(mv).padStart(6)}  (4段理论 17)   用时 ${dt}ms   ${(64/(dt/1000)).toFixed(0)} 帧/秒`);
    }
  } catch(e){ console.error('FAILED:', (e&&e.stack)||e); }
  finally { await m.close(); }
})();
