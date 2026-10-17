const fs=require('fs');const {Match}=require('./match');
const FRAMES=Number(process.env.FRAMES||40), TRIALS=Number(process.env.TRIALS||6), TAG=process.env.TAG||'ac';
const INSTALL=`(()=>{window.__a={buf:[],n:0,ids:null,
 ad:()=>VantageSandbox.createAdapter(GameManager.getGameController(),'tank_a'),
 opps:function(){var tk=window.__a.ad().getTanks();var o=[];for(var k in tk)if(k!=='tank_a')o.push(k);return o;},
 read:function(pid){var t=window.__a.ad().getTanks()[pid];if(!t)return null;var f=function(n,d){try{return typeof t[n]==='function'?!!t[n]():d;}catch(e){return d;}};
  return [f('getForward'),f('getBack'),f('getLeft'),f('getRight'),f('getFireDown'),f('getLocked')];},
 inj:function(pid,a){var t=window.__a.ad().getTanks()[pid];if(!t||!a)return false;var nm=['Forward','Back','Left','Right','FireDown','Locked'];
  for(var i=0;i<6;i++){var c='set'+nm[i];if(typeof t[c]==='function'){try{t[c](!!a[i]);}catch(e){}}}return true;},
 tick:function(rec){var ad=window.__a.ad();var e=VantageObserve.encode({adapter:ad,tree:null,horizonSec:10,K_death:1,frameDt:1/60});
  var ids=window.__a.ids||(window.__a.ids=window.__a.opps()),acts={};
  for(var i=0;i<ids.length;i++){var pid=ids[i];if(rec&&rec.acts&&rec.acts[pid])window.__a.inj(pid,rec.acts[pid]);acts[pid]=window.__a.read(pid);}
  window.__a.buf.push({t:window.__a.n++,g:e.global.globalTok,opp:e.global.oppTok,acts:acts});return 1;}};return 1;})()`;
async function phase(m,rec){await m.clearControl();await m.eval(INSTALL);await m.eval('window.__a.ids=window.__a.opps();');
 for(let i=0;i<FRAMES;i++){ if(rec){await m.eval('window.__a.tick('+JSON.stringify(rec[i])+')');await m.pump(1,{yieldMs:0});} else {await m.eval('window.__a.tick()');await m.pump(1,{yieldMs:0});} }
 return JSON.parse(await m.eval('JSON.stringify(window.__a.buf)'));}
(async()=>{ const NAMES=JSON.parse(await (async()=>{const T=new Match();await T.open({humanIds:['tank_a'],aiCount:2,vantCount:0});const n=await T.eval('JSON.stringify({g:VantageObserve.GLOBAL_FIELDS,o:VantageObserve.OPP_FIELDS})');await T.close();return n;})());
 let hit=null;
 for(let t=0;t<TRIALS&&!hit;t++){ const A=new Match();await A.open({humanIds:['tank_a'],aiCount:2,vantCount:0,rng:'record',rngMode:'record'});
  const rec=await phase(A,null);const sites=await A.eval('JSON.stringify(window.__vtRng.dumpSites())');const seq=await A.eval('JSON.stringify(window.__vtRng.dump())');await A.close();
  const B=new Match();await B.open({humanIds:['tank_a'],aiCount:2,vantCount:0,rngSites:JSON.parse(sites),rngSeq:JSON.parse(seq)});
  const rep=await phase(B,rec);await B.close();
  const per=[];for(let i=0;i<FRAMES;i++){const a=rec[i],b=rep[i];let n=0,orot=null,names=[];
   if(a&&b){for(let k=0;k<Math.max(a.g.length,b.g.length);k++)if(a.g[k]!==b.g[k]){n++;names.push(NAMES.g[k]+':'+(b.g[k]-a.g[k]).toExponential(2));}
    for(let k=0;k<Math.max(a.opp.length,b.opp.length);k++)if(a.opp[k]!==b.opp[k]){n++;names.push('opp.'+NAMES.o[k%NAMES.o.length]+':'+(b.opp[k]-a.opp[k]).toExponential(2));
      if(k===2)orot=Math.abs(a.opp[2]-b.opp[2]);}}
   per.push({t:i,nDims:n,orotDelta:orot,names:names.slice(0,4)});}
  const badN=per.filter(x=>x.nDims>0).length;
  console.log('T'+t+' badFrames='+badN+' orotDeltas='+JSON.stringify(per.map(x=>x.orotDelta)));
  if(badN>0){hit={trial:t,per:per};break;} }
 if(hit){const d=hit.per.filter(x=>x.nDims>0);
  console.log('HIT trial='+hit.trial+' badFrames='+d.length+' firstBad='+d[0].t+' lastBad='+d[d.length-1].t);
  console.log('DELTA_SERIES '+JSON.stringify(d.map(x=>({t:x.t,n:x.nDims,orot:x.orotDelta})))
  );
  console.log('NAMES_SAMPLE '+JSON.stringify(d.slice(0,4).map(x=>x.names)));
  console.log('NAMES_LAST '+JSON.stringify(d.slice(-3).map(x=>x.names)));}
 else console.log('NO_BAD_RUN in '+TRIALS);
 fs.writeFileSync('D:/vt_run/datasets/accum_'+TAG+'.json',JSON.stringify({hit:hit||null,TRIALS:TRIALS,FRAMES:FRAMES}));})();
