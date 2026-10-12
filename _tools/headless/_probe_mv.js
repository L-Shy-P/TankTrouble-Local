const { Match } = require('./match');
const TILE = 10;
(async () => {
  const m = new Match();
  try {
    await m.open({ humanIds:['tank_a','tank_b'], aiCount:0, vantCount:0 });
    // 自适应预热
    await m.clearControl();
    let started=false;
    for (let i=0;i<30;i++){ const a=await m.myTank(); if(!a)break;
      await m.setControl({fwd:true}); await m.pump(8,{yieldMs:4});
      const b=await m.myTank(); if(b&&Math.hypot(b.x-a.x,b.y-a.y)>0.5){started=true;break;} }
    await m.clearControl();
    console.log('回合开始:', started);

    const mz = await m.maze();
    const cand = mz.reachable.map(r=>({x:r.x*TILE+5,y:r.y*TILE+5}));
    const A = cand[0];
    await m.teleport('tank_a', A.x, A.y, 1.5);
    await m.pump(6,{yieldMs:4});

    // 方案 A：一次 evaluate 里连续 16 帧（现在 rollout_worker 的做法）
    let a0 = await m.myTank();
    await m.eval("window.__vtCtrl.fwd=true");
    await m.eval("window.__vtStep(16)");
    await m.eval("window.__vtCtrl.fwd=false");
    let a1 = await m.myTank();
    console.log(`A 一次性 __vtStep(16):     位移 ${a1?Math.hypot(a1.x-a0.x,a1.y-a0.y).toFixed(2):'-'}`);

    await m.teleport('tank_a', A.x, A.y, 1.5); await m.pump(6,{yieldMs:4});
    // 方案 B：16 次独立 evaluate，无睡眠
    a0 = await m.myTank();
    await m.eval("window.__vtCtrl.fwd=true");
    for (let i=0;i<16;i++) await m.eval("window.__vtStep(1)");
    await m.eval("window.__vtCtrl.fwd=false");
    a1 = await m.myTank();
    console.log(`B 16 次独立 evaluate:      位移 ${a1?Math.hypot(a1.x-a0.x,a1.y-a0.y).toFixed(2):'-'}`);

    await m.teleport('tank_a', A.x, A.y, 1.5); await m.pump(6,{yieldMs:4});
    // 方案 C：16 次独立 evaluate + 每帧真实睡眠 4ms（diag_move 的做法）
    a0 = await m.myTank();
    await m.eval("window.__vtCtrl.fwd=true");
    for (let i=0;i<16;i++) { await m.eval("window.__vtStep(1)"); await new Promise(r=>setTimeout(r,4)); }
    await m.eval("window.__vtCtrl.fwd=false");
    a1 = await m.myTank();
    console.log(`C 16 次 evaluate + 4ms 睡眠: 位移 ${a1?Math.hypot(a1.x-a0.x,a1.y-a0.y).toFixed(2):'-'}`);

    await m.teleport('tank_a', A.x, A.y, 1.5); await m.pump(6,{yieldMs:4});
    // 方案 D：中间插一次真实睡眠，再一次性跑
    a0 = await m.myTank();
    await m.eval("window.__vtCtrl.fwd=true");
    await new Promise(r=>setTimeout(r,30));
    await m.eval("window.__vtStep(16)");
    await m.eval("window.__vtCtrl.fwd=false");
    a1 = await m.myTank();
    console.log(`D 睡眠30ms后一次性16帧:     位移 ${a1?Math.hypot(a1.x-a0.x,a1.y-a0.y).toFixed(2):'-'}`);
  } catch(e){ console.error('FAILED:', (e&&e.stack)||e); }
  finally { await m.close(); }
})();
