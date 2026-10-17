const fs=require('fs');const {Match}=require('./match');
const FRAMES=Number(process.env.FRAMES||1200), N=Number(process.env.N||3), TAG=process.env.TAG||'bg';
(async()=>{const rounds=[];
 for(let k=0;k<N;k++){ const m=new Match();
  await m.open({humanIds:['tank_a'],aiCount:2,vantCount:0,rng:'record',rngMode:'record'});
  const len=async()=>Number(await m.eval('(function(){try{var d=window.__vtRng.dump();return d?d.length:0;}catch(e){return -1;}})()'));
  const init=await len(); const marks=[{f:0,n:init}];
  const step=Math.max(1,Math.floor(FRAMES/6));
  for(let i=1;i<=FRAMES;i++){ await m.pump(1,{yieldMs:0}); if(i%step===0||i===FRAMES)marks.push({f:i,n:await len()}); }
  const total=marks[marks.length-1].n; await m.close();
  const perFrame=(total-init)/FRAMES;
  rounds.push({round:k,init:init,total:total,perFrame:perFrame.toFixed(2),totalBytes:total*8,initBytes:init*8,marks:marks});
  console.log('R'+k+' init='+init+' total='+total+' perFrame='+perFrame.toFixed(2)+' bytes='+(total*8)+' marks='+JSON.stringify(marks)); }
 const inits=rounds.map(r=>r.init).sort((a,b)=>a-b),totals=rounds.map(r=>r.total).sort((a,b)=>a-b);
 const med=(a)=>a[Math.floor(a.length/2)];
 console.log('BUDGET '+JSON.stringify({N:N,frames:FRAMES,initMin:inits[0],initMed:med(inits),initMax:inits[inits.length-1],
  totalMin:totals[0],totalMed:med(totals),totalMax:totals[totals.length-1],
  bytesMin:totals[0]*8,bytesMed:med(totals)*8,bytesMax:totals[totals.length-1]*8,
  gamesIn17GB:[Math.floor(17e9/(totals[totals.length-1]*8)),Math.floor(17e9/(totals[0]*8))]}));
 fs.writeFileSync('D:/vt_run/datasets/budget_'+TAG+'.json',JSON.stringify(rounds));})();
