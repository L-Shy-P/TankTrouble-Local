const fs=require('fs'),path=require('path');const {Match}=require('./match');
const FRAMES=Number(process.env.FRAMES||40), TAG=process.env.TAG||('c'+process.pid), OUT=process.env.OUT||'D:/vt_run/datasets';
const INSTALL=`(()=>{window.__c={buf:[],n:0,ids:null,
 ad:()=>VantageSandbox.createAdapter(GameManager.getGameController(),'tank_a'),
 opps:function(){var tk=window.__c.ad().getTanks();var o=[];for(var k in tk)if(k!=='tank_a')o.push(k);return o;},
 read:function(pid){var t=window.__c.ad().getTanks()[pid];if(!t)return null;var f=function(n,d){try{return typeof t[n]==='function'?!!t[n]():d;}catch(e){return d;}};
  return [f('getForward'),f('getBack'),f('getLeft'),f('getRight'),f('getFireDown'),f('getLocked')];},
 inj:function(pid,a){var t=window.__c.ad().getTanks()[pid];if(!t||!a)return false;var nm=['Forward','Back','Left','Right','FireDown','Locked'];
  for(var i=0;i<6;i++){var c='set'+nm[i];if(typeof t[c]==='function'){try{t[c](!!a[i]);}catch(e){}}}return true;},
 pack:function(a){var v=0;for(var i=0;i<6;i++)if(a[i])v|=(1<<i);return v;},
 tick:function(rec){var ad=window.__c.ad();var e=VantageObserve.encode({adapter:ad,tree:null,horizonSec:10,K_death:1,frameDt:1/60});
  var ids=window.__c.ids||(window.__c.ids=window.__c.opps()),acts={},packed={};
  for(var i=0;i<ids.length;i++){var pid=ids[i];if(rec&&rec.acts&&rec.acts[pid])window.__c.inj(pid,rec.acts[pid]);
   var a=window.__c.read(pid);acts[pid]=a;packed[pid]=window.__c.pack(a);}
  window.__c.buf.push({t:window.__c.n++,g:e.global.globalTok,opp:e.global.oppTok,acts:acts,packed:packed});return 1;},
 end:function(){try{var gc=GameManager.getGameController();return JSON.stringify({ended:!!(gc.isEnded&&gc.isEnded()),state:String(gc.getGameState?gc.getGameState():'')});}catch(e){return '{}';}}};return 1;})()`;
async function phase(m,rec){await m.clearControl();await m.eval(INSTALL);await m.eval('window.__c.ids=window.__c.opps();');
 for(let i=0;i<FRAMES;i++){ if(rec){await m.eval('window.__c.tick('+JSON.stringify(rec[i])+')');await m.pump(1,{yieldMs:0});} else {await m.eval('window.__c.tick()');await m.pump(1,{yieldMs:0});} }
 return {buf:JSON.parse(await m.eval('JSON.stringify(window.__c.buf)')),end:JSON.parse(await m.eval('window.__c.end()'))};}
(async()=>{const t0=Date.now();const A=new Match();await A.open({humanIds:['tank_a'],aiCount:2,vantCount:0,rng:'record',rngMode:'record'});
 const recD=await phase(A,null);const sites=await A.eval('JSON.stringify(window.__vtRng.dumpSites())');const seq=await A.eval('JSON.stringify(window.__vtRng.dump())');await A.close();
 const tRec=Date.now();
 const B=new Match();await B.open({humanIds:['tank_a'],aiCount:2,vantCount:0,rngSites:JSON.parse(sites),rngSeq:JSON.parse(seq)});
 const repD=await phase(B,recD.buf);await B.close();const tRep=Date.now();
 const rec=recD.buf,rep=repD.buf;let bad=[],first=-1,maxd=0;
 for(let i=0;i<FRAMES;i++){const a=rec[i],b=rep[i];let d=0;
  for(let k=0;k<Math.max(a.g.length,b.g.length);k++){if(a.g[k]!==b.g[k])d++;maxd=Math.max(maxd,Math.abs(a.g[k]-b.g[k]));}
  for(let k=0;k<Math.max(a.opp.length,b.opp.length);k++){if(a.opp[k]!==b.opp[k])d++;maxd=Math.max(maxd,Math.abs(a.opp[k]-b.opp[k]));}
  if(d){bad.push(i);if(first<0)first=i;}}
 const ids=Object.keys(rec[0].packed);const packedBytes=Buffer.alloc(FRAMES*ids.length);for(let i=0;i<FRAMES;i++)for(let j=0;j<ids.length;j++)packedBytes[i*ids.length+j]=rec[i].packed[ids[j]];
 fs.writeFileSync(path.join(OUT,'round_'+TAG+'.acts.bin'),packedBytes);
 fs.writeFileSync(path.join(OUT,'round_'+TAG+'.rng.json'),seq);
 const jsonActs=JSON.stringify(rec.map(x=>x.acts));
 const meta={tag:TAG,frames:FRAMES,opponents:ids.length,replayOk:bad.length===0,badFrames:bad.length,firstBadTick:first,maxAbsDelta:maxd,
  bytes:{packedActs:packedBytes.length,jsonActs:Buffer.byteLength(jsonActs),rng:Buffer.byteLength(seq)},endState:recD.end,
  replaysMs:tRep-tRec,recordMs:tRec-t0};
 fs.writeFileSync(path.join(OUT,'round_'+TAG+'.meta.json'),JSON.stringify(meta,null,1));
 console.log('COLLECT '+JSON.stringify(meta));
})();
