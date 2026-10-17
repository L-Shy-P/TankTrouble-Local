const fs=require('fs');const {Match}=require('./match');
const FRAMES=Number(process.env.FRAMES||30), TAG=process.env.TAG||'uc';
const INSTALL=`(()=>{window.__u={buf:[],n:0,
 ad:()=>VantageSandbox.createAdapter(GameManager.getGameController(),'tank_a'),
 tick:function(){var e=VantageObserve.encode({adapter:window.__u.ad(),tree:null,horizonSec:10,K_death:1,frameDt:1/60});
  window.__u.buf.push({t:window.__u.n++,g:e.global.globalTok,opp:e.global.oppTok});return 1;},
 diag:function(){var R=window.__vtRng,o={};
  try{o.uc=R.useCounts?R.useCounts():null;}catch(e){o.ucErr=String(e.message||e);}
  try{o.sites=R.dumpSites?R.dumpSites():null;}catch(e){}
  try{o.seq=R.dump?R.dump():null;}catch(e){}
  return o;}};return 1;})()`;
async function run(m){await m.clearControl();await m.eval(INSTALL);
 for(let i=0;i<FRAMES;i++){await m.pump(1,{yieldMs:0});await m.eval('window.__u.tick()');}
 return {buf:JSON.parse(await m.eval('JSON.stringify(window.__u.buf)')),
   uc:JSON.parse(await m.eval('JSON.stringify(window.__u.diag().uc)')),
   sites:await m.eval('JSON.stringify(window.__u.diag().sites)'),
   seq:await m.eval('JSON.stringify(window.__u.diag().seq)')};}
(async()=>{const names=JSON.parse(await (async()=>{const T=new Match();await T.open({humanIds:['tank_a'],aiCount:2,vantCount:0});const n=await T.eval('JSON.stringify({g:VantageObserve.GLOBAL_FIELDS,o:VantageObserve.OPP_FIELDS})');await T.close();return n;})());
 const A=new Match();await A.open({humanIds:['tank_a'],aiCount:2,vantCount:0,rng:'record',rngMode:'record'});
 const rec=await run(A);await A.close();
 const B=new Match();await B.open({humanIds:['tank_a'],aiCount:2,vantCount:0,rngSites:JSON.parse(rec.sites),rngSeq:JSON.parse(rec.seq)});
 const rep=await run(B);await B.close();
 const ucR=rec.uc||{},ucP=rep.uc||{};const ks={};for(const k in ucR)ks[k]=1;for(const k in ucP)ks[k]=1;
 const ucDiff=[];for(const k in ks){if(ucR[k]!==ucP[k])ucDiff.push({site:k,rec:ucR[k],rep:ucP[k],diff:(ucP[k]||0)-(ucR[k]||0)});}
 const all=[{i:1,a:rec.buf[1],b:rep.buf[1]},{i:2,a:rec.buf[2],b:rep.buf[2]}].map(({i,a,b})=>{const dg=[],do2=[];
   if(a&&b){for(let k=0;k<Math.max(a.g.length,b.g.length);k++)if(a.g[k]!==b.g[k])dg.push({k:k,f:names.g[k],rec:a.g[k],rep:b.g[k]});
     for(let k=0;k<Math.max(a.opp.length,b.opp.length);k++)if(a.opp[k]!==b.opp[k])do2.push({k:k,f:names.o[k%names.o.length],rec:a.opp[k],rep:b.opp[k]});}
   return {tick:i,gDiffN:dg.length,gDiffs:dg.slice(0,6),oppDiffN:do2.length,oppDiffs:do2.slice(0,8)};});
 let ucSameInSites=true;const sl=JSON.parse(rec.sites);for(const k in ucR){if(ucR[k]!==ucP[k])ucSameInSites=false;}
 const out={ucDiffCount:ucDiff.length,ucDiff:ucDiff.slice(0,12),ucRecTotal:Object.keys(ucR).length,ucRepTotal:Object.keys(ucP).length,
   ucRecSample:Object.entries(ucR).slice(0,6),ucRepSample:Object.entries(ucP).slice(0,6),
   sitesType:typeof sl,sitesKeys:(sl&&Object.keys(sl).length)||0,seqLen:(JSON.parse(rec.seq)||[]).length,
   tickDiffs:all};
 console.log('UC '+JSON.stringify(out).slice(0,1700));
 fs.writeFileSync('D:/vt_run/datasets/uc_'+TAG+'.json',JSON.stringify(out));})();
