const fs=require('fs');const {Match}=require('./match');
const FRAMES=Number(process.env.FRAMES||60), TAG=process.env.TAG||'inj';
const INSTALL=`(()=>{window.__r={buf:[],n:0,ids:null,setterNames:null,usedSetter:null,
 asAd:(pid)=>VantageSandbox.createAdapter(GameManager.getGameController(),pid),
 opps:function(){var ad=window.__r.asAd('tank_a');var tk=ad.getTanks();var out=[];
   for(var k in tk){if(k!=='tank_a')out.push(k);}return out;},
 read:function(pid){var ad=window.__r.asAd('tank_a');var t=ad.getTanks()[pid];if(!t)return null;var f=function(n,d){try{return (typeof t[n]==='function')?!!t[n]():d;}catch(e){return d;}};
   return [f('getForward'),f('getBack'),f('getLeft'),f('getRight'),f('getFireDown'),f('getLocked')];},
 probe:function(pid){var t=window.__r.asAd('tank_a').getTanks()[pid];if(!t)return null;var p=Object.getPrototypeOf(t);var ns=Object.getOwnPropertyNames(p).filter(function(n){return /set|press|input|release/i.test(n);});return ns.slice(0,20);},
 inject:function(pid,a){var t=window.__r.asAd('tank_a').getTanks()[pid];if(!t||!a)return false;var names=['Forward','Back','Left','Right','FireDown','Locked'];
   for(var i=0;i<6;i++){var cands=['set'+names[i],'press'+names[i],'set'+names[i].toLowerCase()];
     for(var c=0;c<cands.length;c++){if(typeof t[cands[c]]==='function'){window.__r.usedSetter=cands[c];try{t[cands[c]](!!a[i]);}catch(e){}break;}}}
   return true;},
 tick:function(rec){var gc=GameManager.getGameController();var ad=window.__r.asAd('tank_a');
   var e=VantageObserve.encode({adapter:ad,tree:null,horizonSec:10,K_death:1,frameDt:1/60});var g=e.global;
   var ids=window.__r.ids||(window.__r.ids=window.__r.opps());
   var acts={};for(var i=0;i<ids.length;i++)acts[ids[i]]=window.__r.read(ids[i]);
   if(rec&&rec.acts){for(var j=0;j<ids.length;j++){window.__r.inject(ids[j],rec.acts[ids[j]]);}}
   window.__r.buf.push({t:window.__r.n++,g:g.globalTok,opp:g.oppTok,acts:acts});
   return 1;}};return 1;})()`;
async function run(m,recArr){await m.clearControl();await m.eval(INSTALL);
  await m.eval('window.__r.ids=window.__r.opps()');
  for(let i=0;i<FRAMES;i++){ if(recArr){ await m.eval('window.__r.tick('+JSON.stringify(recArr[i])+')'); await m.pump(1,{yieldMs:0}); } else { await m.pump(1,{yieldMs:0}); await m.eval('window.__r.tick()'); } }
  return JSON.parse(await m.eval('JSON.stringify(window.__r.buf)'));}
(async()=>{const A=new Match();await A.open({humanIds:['tank_a'],aiCount:2,vantCount:0,rng:'flat',rngMode:'flat'});
 const probes=JSON.parse(await A.eval('JSON.stringify(window.__r?{}:{})'))||{};
 const rec=await run(A,null);
 const setter=await A.eval('JSON.stringify({names:window.__r.probe(window.__r.ids[0]),used:window.__r.usedSetter})');
 const seq=await A.eval('JSON.stringify(window.__vtRng.dump())');await A.close();
 const B=new Match();await B.open({humanIds:['tank_a'],aiCount:2,vantCount:0,rngSeq:JSON.parse(seq)});
 const rep=await run(B,rec);await B.close();
 let firstBad=-1,badN=0;for(let i=0;i<rec.length;i++){if(JSON.stringify(rec[i].opp)!==JSON.stringify(rep[i].opp)){badN++;if(firstBad<0)firstBad=i;}}
 const last=FRAMES-1;const A1=rec[last],B1=rep[last];
 const diffs=[];for(let i=0;i<Math.max(A1.opp.length,B1.opp.length);i++){if(A1.opp[i]!==B1.opp[i])diffs.push({i:i,rec:A1.opp[i],rep:B1.opp[i]});}
 console.log('INJ '+JSON.stringify({frames:FRAMES,oppDiffN:badN,firstBadTick:firstBad,setterInfo:JSON.parse(setter),
   ticks:[rec.length,rep.length],globalSame:JSON.stringify(rec[last].g)===JSON.stringify(rep[last].g),
   lastTickOppDiffs:diffs.slice(0,5),lastTickActsRec:A1.acts,lastTickActsRep:B1.acts}));
 fs.writeFileSync('D:/vt_run/datasets/inj_'+TAG+'.json',JSON.stringify({rec:rec[last],rep:rep[last]}));})();
