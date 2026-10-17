const fs=require('fs');const {Match}=require('./match');
const FRAMES=Number(process.env.FRAMES||40), TRIALS=Number(process.env.TRIALS||3), TAG=process.env.TAG||'fin';
const INSTALL=`(()=>{window.__f={buf:[],n:0,ids:null,
 ad:()=>VantageSandbox.createAdapter(GameManager.getGameController(),'tank_a'),
 opps:function(){var tk=window.__f.ad().getTanks();var o=[];for(var k in tk)if(k!=='tank_a')o.push(k);return o;},
 read:function(pid){var t=window.__f.ad().getTanks()[pid];if(!t)return null;var f=function(n,d){try{return typeof t[n]==='function'?!!t[n]():d;}catch(e){return d;}};
  return [f('getForward'),f('getBack'),f('getLeft'),f('getRight'),f('getFireDown'),f('getLocked')];},
 inj:function(pid,a){var t=window.__f.ad().getTanks()[pid];if(!t||!a)return false;var nm=['Forward','Back','Left','Right','FireDown','Locked'];var used=0;
  for(var i=0;i<6;i++){var c='set'+nm[i];if(typeof t[c]==='function'){used=1;try{t[c](!!a[i]);}catch(e){}}}window.__f.used=(window.__f.used||0)+used;return !!used;},
 tick:function(rec){var ad=window.__f.ad();var e=VantageObserve.encode({adapter:ad,tree:null,horizonSec:10,K_death:1,frameDt:1/60});
  var g=e.global,ids=window.__f.ids||(window.__f.ids=window.__f.opps()),acts={};
  for(var i=0;i<ids.length;i++){var pid=ids[i];
    if(rec&&rec.acts&&rec.acts[pid])window.__f.inj(pid,rec.acts[pid]);
    acts[pid]=window.__f.read(pid);}
  var all=g.globalTok.concat(g.oppTok);
  var f32=[];for(var j=0;j<all.length;j++)f32.push(Math.fround(all[j]));
  window.__f.buf.push({t:window.__f.n++,g:g.globalTok,opp:g.oppTok,acts:acts,f32:f32});
  return 1;}};return 1;})()`;
async function phase(m,rec){await m.clearControl();await m.eval(INSTALL);await m.eval('window.__f.ids=window.__f.opps();');
 for(let i=0;i<FRAMES;i++){ if(rec){ await m.eval('window.__f.tick('+JSON.stringify(rec[i])+')'); await m.pump(1,{yieldMs:0}); } else { await m.eval('window.__f.tick()'); await m.pump(1,{yieldMs:0}); } }
 return JSON.parse(await m.eval('JSON.stringify(window.__f.buf)')); }
(async()=>{const trials=[];
 for(let t=0;t<TRIALS;t++){ const A=new Match();
  await A.open({humanIds:['tank_a'],aiCount:2,vantCount:0,rng:'record',rngMode:'record'});
  const rec=await phase(A,null);
  const sites=await A.eval('JSON.stringify(window.__vtRng.dumpSites())'); const seq=await A.eval('JSON.stringify(window.__vtRng.dump())');
  await A.close();
  const B=new Match(); await B.open({humanIds:['tank_a'],aiCount:2,vantCount:0,rngSites:JSON.parse(sites),rngSeq:JSON.parse(seq)});
  const rep=await phase(B,rec); const used=await B.eval('window.__f.used'); await B.close();
  let badRaw=0,badF=0,first=-1,maxd=0;
  for(let i=0;i<FRAMES;i++){ const a=rec[i],b=rep[i]; if(!a||!b){badRaw++;badF++;continue;}
   const rawDiff=JSON.stringify(a.g)!==JSON.stringify(b.g)||JSON.stringify(a.opp)!==JSON.stringify(b.opp);
   const fDiff=JSON.stringify(a.f32)!==JSON.stringify(b.f32);
   if(rawDiff)badRaw++; if(fDiff)badF++;
   if((rawDiff||fDiff)&&first<0)first=i;
   for(let k=0;k<Math.max(a.g.length,b.g.length);k++){const d=Math.abs((a.g[k]||0)-(b.g[k]||0));if(d>maxd)maxd=d;}
   for(let k=0;k<Math.max(a.opp.length,b.opp.length);k++){const d=Math.abs((a.opp[k]||0)-(b.opp[k]||0));if(d>maxd)maxd=d;} }
  trials.push({trial:t,frames:FRAMES,badRaw:badRaw,badF32:badF,firstBad:first,maxAbsDiff:maxd,injectUsed:used,
    tick0same:JSON.stringify(rec[0].opp)===JSON.stringify(rep[0].opp)});
  console.log('T'+t+' '+JSON.stringify(trials[trials.length-1])); }
 const agg={trials:trials,totalFrames:FRAMES*TRIALS,badF32Sum:trials.reduce((a,x)=>a+x.badF32,0),TRIALS:TRIALS,FRAMES:FRAMES};
 console.log('FINAL '+JSON.stringify(agg).slice(0,900));
 fs.writeFileSync('D:/vt_run/datasets/final_'+TAG+'.json',JSON.stringify(agg));})();
