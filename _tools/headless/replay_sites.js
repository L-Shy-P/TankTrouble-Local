const fs=require('fs');const {Match}=require('./match');
const FRAMES=Number(process.env.FRAMES||30), TAG=process.env.TAG||'st';
const INSTALL=`(()=>{window.__s={buf:[],n:0,ids:null,pre:[],post:[],
 ad:()=>VantageSandbox.createAdapter(GameManager.getGameController(),'tank_a'),
 opps:function(){var tk=window.__s.ad().getTanks();var o=[];for(var k in tk)if(k!=='tank_a')o.push(k);return o;},
 read:function(pid){var t=window.__s.ad().getTanks()[pid];if(!t)return null;var f=function(n,d){try{return typeof t[n]==='function'?!!t[n]():d;}catch(e){return d;}};
  return [f('getForward'),f('getBack'),f('getLeft'),f('getRight'),f('getFireDown'),f('getLocked')];},
 pos:function(pid){var t=window.__s.ad().getTanks()[pid];if(!t)return null;return [t.getX(),t.getY(),t.getRotation()];},
 inj:function(pid,a){var t=window.__s.ad().getTanks()[pid];if(!t||!a)return false;var nm=['Forward','Back','Left','Right','FireDown','Locked'];var used=null;
  for(var i=0;i<6;i++){var c='set'+nm[i];if(typeof t[c]==='function'){used=c;try{t[c](!!a[i]);}catch(e){}}}
  window.__s.lastSetter=used;return !!used;},
 sites:function(){var R=window.__vtRng;var o={keys:Object.keys(R)};
  try{o.sites=R.dumpSites?R.dumpSites():null;}catch(e){o.sitesErr=String(e.message||e);}
  try{o.counts=R.useCounts?R.useCounts():null;}catch(e){o.countsErr=String(e.message||e);}
  return o;},
 tick:function(rec){var ad=window.__s.ad();var e=VantageObserve.encode({adapter:ad,tree:null,horizonSec:10,K_death:1,frameDt:1/60});
  var ids=window.__s.ids||(window.__s.ids=window.__s.opps());var cur={},pos={};
  for(var i=0;i<ids.length;i++){var pid=ids[i];
    if(rec&&rec.acts&&rec.acts[pid]){ if(window.__s.n<3)window.__s.pre.push(window.__s.read(pid)); window.__s.inj(pid,rec.acts[pid]); if(window.__s.n<3)window.__s.post.push(window.__s.read(pid)); }
    cur[pid]=window.__s.read(pid);pos[pid]=window.__s.pos(pid);}
  window.__s.buf.push({t:window.__s.n++,opp:e.global.oppTok,acts:cur,pos:pos});
  return 1;}};return 1;})()`;
async function run(m,rec){await m.clearControl();await m.eval(INSTALL);await m.eval('window.__s.ids=window.__s.opps()');
 for(let i=0;i<FRAMES;i++){ if(rec){ await m.eval('window.__s.tick('+JSON.stringify(rec[i])+')'); await m.pump(1,{yieldMs:0}); } else { await m.pump(1,{yieldMs:0}); await m.eval('window.__s.tick()'); } }
 return {buf:JSON.parse(await m.eval('JSON.stringify(window.__s.buf)')),pre:JSON.parse(await m.eval('JSON.stringify(window.__s.pre)')),post:JSON.parse(await m.eval('JSON.stringify(window.__s.post)')),setter:await m.eval('window.__s.lastSetter'),sites:JSON.parse(await m.eval('JSON.stringify(window.__s.sites())'))};}
(async()=>{const A=new Match();await A.open({humanIds:['tank_a'],aiCount:2,vantCount:0,rng:'flat',rngMode:'flat'});
 const rec=await run(A,null);const seq=await A.eval('JSON.stringify(window.__vtRng.dump())');await A.close();
 const B=new Match();await B.open({humanIds:['tank_a'],aiCount:2,vantCount:0,rngSeq:JSON.parse(seq)});
 const rep=await run(B,rec.buf);await B.close();
 const sitesInfo={recKeys:rec.sites.keys,repKeys:rep.sites.keys,recSitesType:typeof rec.sites.sites,repSitesType:typeof rep.sites.sites,
   recSitesLen:(rec.sites.sites&&rec.sites.sites.length)||null,repSitesLen:(rep.sites.sites&&rep.sites.sites.length)||null,
   sitesJsonSame:JSON.stringify(rec.sites.sites)===JSON.stringify(rep.sites.sites),
   countsJsonSame:JSON.stringify(rec.sites.counts)===JSON.stringify(rep.sites.counts),
   recSitesSample:rec.sites.sites?rec.sites.sites.slice(0,3):null,repSitesSample:rep.sites.sites?rep.sites.sites.slice(0,3):null,
   recCounts:rec.sites.counts,repCounts:rep.sites.counts};
 let bad=-1;for(let i=0;i<Math.max(rec.buf.length,rep.buf.length);i++){if(JSON.stringify(rec.buf[i].opp)!==JSON.stringify(rep.buf[i].opp)){bad=i;break;}}
 console.log('SITES '+JSON.stringify(sitesInfo).slice(0,1200));
 console.log('INJINFO '+JSON.stringify({setterB:rep.setter,pre:rep.pre.slice(0,2),post:rep.post.slice(0,2),frames:FRAMES,firstBadOppTick:bad,tick0diff:JSON.stringify(rec.buf[0]&&rep.buf[0]?{rec:rec.buf[0].opp,rep:rep.buf[0].opp}:null).slice(0,300)}));
 fs.writeFileSync('D:/vt_run/datasets/sites_'+TAG+'.json',JSON.stringify({sitesInfo:JSON.stringify(sitesInfo).slice(0,1200)}));})();
