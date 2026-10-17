const fs=require('fs'),cp=require('child_process');const {Match}=require('./match');
const FRAMES=Number(process.env.FRAMES||40), TRIALS=Number(process.env.TRIALS||6), TAG=process.env.TAG||'lp';
function load(){try{const s=cp.execSync('powershell -NoProfile -Command "$c=Get-Process chrome -ErrorAction SilentlyContinue;$n=Get-Process node -ErrorAction SilentlyContinue;\'{0}|{1}|{2}\' -f (($c|Measure-Object).Count),(($n|Measure-Object).Count),([math]::Round((($c|Measure-Object -Property CPU -Sum).Sum),1))"',{encoding:'utf8',timeout:20000});return s.trim();}catch(e){return 'loadErr';}}
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
 const cat=(f)=>{ if(/^(selfX|selfY|selfRot|ox|oy|orot|dX|dY|dRot)$/.test(f))return 'pose'; if(/Alive|roundState|timeType|timeLeft/.test(f))return 'alive/time'; if(/ammo|Ammo|wpnType|WpnType/.test(f))return 'weapon/ammo'; if(/Fwd|Back|Left|Right|Locked|Fire/.test(f))return 'keys'; if(/shield|Shield/.test(f))return 'shield'; if(/Cool|Reload|queue|Crate|crate/.test(f))return 'cooldown/crate'; if(/dVictim|dKiller|dDeadly|dTAge|UpgradeMask|wpnKnown/.test(f))return 'death/mask'; return 'other'; };
 const trials=[];let hit=null;
 for(let t=0;t<TRIALS;t++){ const L0=load();
  const A=new Match();await A.open({humanIds:['tank_a'],aiCount:2,vantCount:0,rng:'record',rngMode:'record'});
  const rec=await phase(A,null);const sites=await A.eval('JSON.stringify(window.__vtRng.dumpSites())');const seq=await A.eval('JSON.stringify(window.__vtRng.dump())');await A.close();
  const B=new Match();await B.open({humanIds:['tank_a'],aiCount:2,vantCount:0,rngSites:JSON.parse(sites),rngSeq:JSON.parse(seq)});
  const rep=await phase(B,rec);await B.close(); const L1=load();
  let bad=[],first=-1;
  for(let i=0;i<FRAMES;i++){const a=rec[i],b=rep[i];const d=[];
   if(a&&b){for(let k=0;k<Math.max(a.g.length,b.g.length);k++)if(a.g[k]!==b.g[k])d.push({i:k,f:NAMES.g[k],rec:a.g[k],rep:b.g[k],c:cat(NAMES.g[k]||'')});
    for(let k=0;k<Math.max(a.opp.length,b.opp.length);k++)if(a.opp[k]!==b.opp[k])d.push({i:k,f:'opp.'+NAMES.o[k%NAMES.o.length],rec:a.opp[k],rep:b.opp[k],c:cat(NAMES.o[k%NAMES.o.length]||'')});}
   if(d.length){bad.push(i);if(first<0){first=i;hit={trial:t,tick:i,diffs:d.slice(0,12),cat:cat};}}}
  const T={trial:t,badFrames:bad.length,firstBad:first,loadBefore:L0,loadAfter:L1,badTicks:bad.slice(0,6)};
  trials.push(T); console.log('TR'+t+' '+JSON.stringify(T));
  if(first>=0){console.log('HIT '+JSON.stringify({trial:t,tick:first,diffs:(hit.diffs||[])}));break;} }
 const out={trials:trials,firstHit:hit,FRAMES:FRAMES,TRIALS:TRIALS};
 console.log('LOOP '+JSON.stringify({n:trials.length,badTrials:trials.filter(x=>x.badFrames>0).length,summary:trials.map(x=>x.trial+':'+x.badFrames)}));
 fs.writeFileSync('D:/vt_run/datasets/loop_'+TAG+'.json',JSON.stringify(out));})();
