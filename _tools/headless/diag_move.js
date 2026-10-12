const { Match } = require('./match');
const OPS = [null,{n:'前',fwd:1},{n:'后',back:1},{n:'左',left:1},{n:'右',right:1},
             {n:'前左',fwd:1,left:1},{n:'前右',fwd:1,right:1},{n:'后左',back:1,left:1},{n:'后右',back:1,right:1}];
(async () => {
  const m = new Match();
  try {
    await m.open({ humanIds:['tank_a'], aiCount:0, vantCount:1 });
    // 自适应预热
    await m.clearControl();
    let started=false;
    for (let i=0;i<30;i++){ const a=await m.myTank(); if(!a)break;
      await m.setControl({fwd:true}); await m.pump(8,{yieldMs:4});
      const b=await m.myTank(); if(b&&Math.hypot(b.x-a.x,b.y-a.y)>0.5){started=true;break;} }
    await m.clearControl();
    console.log('回合开始:',started);
    const mz = await m.maze();
    const TILE=10;
    const cand = mz.reachable.map(r=>({x:r.x*TILE+5,y:r.y*TILE+5}));
    const A = cand[0];
    console.log('传送到', JSON.stringify(A));
    await m.teleport('tank_a', A.x, A.y, 0);
    await m.pump(10,{yieldMs:5});
    const s0 = await m.myTank();
    console.log('传送后:', JSON.stringify(s0));

    // 逐操作测试：每个操作单独跑 20 帧，看位移和转角
    for (const op of [1,2,3,4,1,5]) {
      const before = await m.myTank();
      if(!before) break;
      await m.clearControl();
      await m.pump(3,{yieldMs:4});
      const mid = await m.myTank();
      const o = OPS[op];
      await m.setControl({fwd:!!o.fwd,back:!!o.back,left:!!o.left,right:!!o.right});
      await m.pump(20,{yieldMs:0});
      await m.clearControl();
      const after = await m.myTank();
      console.log(`  ${o.n.padEnd(3)} 位移=${Math.hypot(after.x-mid.x,after.y-mid.y).toFixed(2).padStart(6)}  ` +
        `Δrot=${(after.rot-mid.rot).toFixed(3).padStart(7)}  pos (${mid.x.toFixed(0)},${mid.y.toFixed(0)})→(${after.x.toFixed(0)},${after.y.toFixed(0)})`);
    }
    console.log('\n时钟:', JSON.stringify(await m.stats()));
  } catch(e){ console.error('FAILED:',(e&&e.stack)||e); process.exitCode=1; }
  finally { await m.close(); }
})();
