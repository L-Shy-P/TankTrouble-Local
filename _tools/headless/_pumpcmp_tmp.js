const {Match}=require('./match');
(async()=>{const m=new Match();
 await m.open({humanIds:['tank_a'],aiCount:1,vantCount:1});
 await m.clearControl(); await m.pump(30,{yieldMs:0});
 console.log('INIT_OK');
 async function run(label,K,reps){
   const per=[];
   for(let r=0;r<reps;r++){const t0=process.hrtime.bigint();await m.pump(K,{yieldMs:0});per.push(Number(process.hrtime.bigint()-t0)/1e6/K);}
   per.sort((a,b)=>a-b);
   const mean=per.reduce((a,b)=>a+b,0)/per.length;
   console.log('PUMPCMP '+label+' per_frame_ms mean='+mean.toFixed(2)+' median='+per[Math.floor(per.length/2)].toFixed(2)+' min='+per[0].toFixed(2)+' max='+per[per.length-1].toFixed(2));
 }
 await run('pump1_x600',1,600);
 await run('pump60_x10',60,10);
 await run('pump600_x1',600,1);
 await run('pump1_again',1,300);
 await m.close();})();
