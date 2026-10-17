const fs=require('fs');const {Match}=require('./match');
const FRAMES=Number(process.env.FRAMES||12), TAG=process.env.TAG||'d2';
const INSTALL=`(()=>{window.__q={buf:[],n:0,ids:null,
 ad:()=>VantageSandbox.createAdapter(GameManager.getGameController(),'tank_a'),
 opps:function(){var tk=window.__q.ad().getTanks();var o=[];for(var k in tk)if(k!=='tank_a')o.push(k);return o;},
 read:function(pid){var t=window.__q.ad().getTanks()[pid];if(!t)return null;var f=function(n,d){try{return typeof t[n]==='function'?!!t[n]():d;}catch(e){return d;}};
  return [f('getForward'),f('getBack'),f('getLeft'),f('getRight'),f('getFireDown'),f('getLocked')];},
 inj:function(pid,a){var t=window.__q.ad().getTanks()[pid];if(!t||!a)return false;var nm=['Forward','Back','Left','Right','FireDown','Locked'];
  for(var i=0;i<6;i++){var c='set'+nm[i];if(typeof t[c]==='function'){try{t[c](!!a[i]);}catch(e){}}}return true;},
 tick:function(rec){var ad=window.__q.ad();var e=VantageObserve.encode({adapter:ad,tree:null,horizonSec:10,K_death:1,frameDt:1/60});
  var ids=window.__q.ids||(window.__q.ids=window.__q.opps()),acts={};
  for(var i=0;i<ids.length;i++){var pid=ids[i];if(rec&&rec.acts&&rec.acts[pid])window.__q.inj(pid,rec.acts[pid]);acts[pid]=window.__q.read(pid);}
  window.__q.buf.push({t:window.__q.n++,g:e.global.globalTok,opp:e.global.oppTok,acts:acts});return 1;}};return 1;})()`;
async function phase(m,rec){await m.clearControl();await m.eval(INSTALL);await m.eval('window.__q.ids=window.__q.opps();');
 for(let i=0;i<FRAMES;i++){ if(rec){await m.eval('window.__q.tick('+JSON.stringify(rec[i])+')');await m.pump(1,{yieldMs:0});} else {await m.eval('window.__q.tick()');await m.pump(1,{yieldMs:0});} }
 return JSON.parse(await m.eval('JSON.stringify(window.__q.buf)'));}
(async()=>{ const NAMES=JSON.parse(await (async()=>{const T=new Match();await T.open({humanIds:['tank_a'],aiCount:2,vantCount:0});const n=await T.eval('JSON.stringify({g:VantageObserve.GLOBAL_FIELDS,o:VantageObserve.OPP_FIELDS})');await T.close();return n;})());
 const A=new Match();await A.open({humanIds:['tank_a'],aiCount:2,vantCount:0,rng:'record',rngMode:'record'});
 const rec=await phase(A,null);const sites=await A.eval('JSON.stringify(window.__vtRng.dumpSites())');const seq=await A.eval('JSON.stringify(window.__vtRng.dump())');await A.close();
 const B=new Match();await B.open({humanIds:['tank_a'],aiCount:2,vantCount:0,rngSites:JSON.parse(sites),rngSeq:JSON.parse(seq)});
 const rep=await phase(B,rec);await B.close();
 const cat=(f)=>{ if(/^(selfX|selfY|selfRot|ox|oy|orot|dX|dY|dRot)$/.test(f))return 'pose';
  if(/Alive|roundState|timeType|timeLeft/.test(f))return 'alive/time';
  if(/ammo|Ammo|wpnType|WpnType/.test(f))return 'weapon/ammo';
  if(/Fwd|Back|Left|Right|Locked|Fire/.test(f))return 'keys';
  if(/shield|Shield/.test(f))return 'shield';
  if(/Cool|Reload|queue|Crate|crate/.test(f))return 'cooldown/crate';
  if(/dVictim|dKiller|dDeadly|dTAge|UpgradeMask|wpnKnown/.test(f))return 'death/mask';
  return 'other'; };
 const perTick=[],tally={};
 for(let t=0;t<FRAMES;t++){const a=rec[t],b=rep[t],d=[];
  if(a&&b){for(let i=0;i<Math.max(a.g.length,b.g.length);i++)if(a.g[i]!==b.g[i])d.push({i:i,f:NAMES.g[i],rec:a.g[i],rep:b.g[i],c:cat(NAMES.g[i]||'')});
   for(let i=0;i<Math.max(a.opp.length,b.opp.length);i++)if(a.opp[i]!==b.opp[i])d.push({i:i,f:'opp.'+(NAMES.o[i%NAMES.o.length]),rec:a.opp[i],rep:b.opp[i],c:cat(NAMES.o[i%NAMES.o.length]||'')});}
  perTick.push({t:t,n:d.length,diffs:d});
  for(const x of d)tally[x.c]=(tally[x.c]||0)+1;}
 const out={frames:FRAMES,perTick:perTick.map(x=>({t:x.t,n:x.n,diffs:x.diffs.slice(0,10)})),categoryTally:tally,
  firstBadTick:(perTick.find(x=>x.n>0)||{}).t ?? null, badTicks:perTick.filter(x=>x.n>0).map(x=>x.t)};
 console.log(JSON.stringify(out).slice(0,1900));
 fs.writeFileSync('D:/vt_run/datasets/d2_'+TAG+'.json',JSON.stringify(out));})();
