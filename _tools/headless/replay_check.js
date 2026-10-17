const fs=require('fs'),path=require('path');const {Match}=require('./match');
const FRAMES=Number(process.env.FRAMES||300), TAG=process.env.TAG||('rc'+process.pid);
const LOG='/tmp/replay_'+TAG+'.log';
function log(){const s=new Date().toISOString()+' '+Array.prototype.join.call(arguments,' ')+'\n';try{fs.appendFileSync(LOG,s);}catch(e){}try{process.stdout.write(s);}catch(e){}}
process.on('uncaughtException',e=>{log('UNCAUGHT '+String(e&&e.stack||e));process.exitCode=9;});
process.on('unhandledRejection',e=>{log('UNHANDLED '+String(e&&e.stack||e));process.exitCode=8;});
process.on('exit',c=>{log('EXIT code='+c);});
const INSTALL=`(()=>{window.__c2={buf:[],n:0,hash:function(a){var h=2166136261;for(var i=0;i<a.length;i++){h^=(a[i]|0);h=(h*16777619)>>>0;}return h;},
 tick:function(){var gc=GameManager.getGameController();var ad=VantageSandbox.createAdapter(gc,'tank_a');
  var enc=VantageObserve.encode({adapter:ad,tree:window.VantageTree||null,horizonSec:10,K_death:1,frameDt:1/60});
  var ts=ad.getTankState()||{};var act=[ts.forward?1:0,ts.back?1:0,ts.left?1:0,ts.right?1:0,ts.fireDown?1:0];
  var all=enc.global.globalTok.concat(enc.global.oppTok||[]);
  window.__c2.buf.push({t:window.__c2.n++,d:enc.dims.total,h:window.__c2.hash(all),a:act});return 1;}};return 1;})()`;
async function run(m,label){ await m.clearControl(); await m.eval(INSTALL);
  for(let i=0;i<FRAMES;i++){ await m.pump(1,{yieldMs:0}); await m.eval('window.__c2.tick()'); }
  return JSON.parse(await m.eval('JSON.stringify(window.__c2.buf)')); }
(async()=>{ const A=new Match();
  await A.open({humanIds:['tank_a'],aiCount:2,vantCount:0,rng:'flat',rngMode:'flat'});
  const rec=await run(A,'rec'); const seq=await A.eval('JSON.stringify(window.__vtRng.dump())'); await A.close();
  log('REC ticks='+rec.length+' rngN='+JSON.parse(seq).length);
  const B=new Match();
  await B.open({humanIds:['tank_a'],aiCount:2,vantCount:0,rngSeq:JSON.parse(seq)});
  const rep=await run(B,'rep'); await B.close();
  let bad=-1,badN=0; for(let i=0;i<Math.max(rec.length,rep.length);i++){ if(!rec[i]||!rep[i]||rec[i].h!==rep[i].h){ badN++; if(bad<0) bad=i; } }
  const out={recTicks:rec.length,repTicks:rep.length,mismatchCount:badN,firstMismatch:bad,
    h0rec:rec[0]?rec[0].h:null,h0rep:rep[0]?rep[0].h:null,
    hLastRec:rec[rec.length-1]?rec[rec.length-1].h:null,hLastRep:rep[rep.length-1]?rep[rep.length-1].h:null,
    sampleRec:rec.slice(0,3).map(x=>x.h),sampleRep:rep.slice(0,3).map(x=>x.h)};
  log('REPLAY '+JSON.stringify(out));
  fs.writeFileSync('D:/vt_run/datasets/replay_'+TAG+'.json',JSON.stringify(out));
})();
