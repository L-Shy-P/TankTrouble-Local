const fs=require('fs');const {Match}=require('./match');
const FRAMES=Number(process.env.FRAMES||30), TAG=process.env.TAG||'ps';
const INSTALL=`(()=>{window.__p={buf:[],n:0,ids:null,
 ad:()=>VantageSandbox.createAdapter(GameManager.getGameController(),'tank_a'),
 opps:function(){var tk=window.__p.ad().getTanks();var o=[];for(var k in tk)if(k!=='tank_a')o.push(k);return o;},
 tick:function(){var ad=window.__p.ad();var e=VantageObserve.encode({adapter:ad,tree:null,horizonSec:10,K_death:1,frameDt:1/60});
  window.__p.buf.push({t:window.__p.n++,opp:e.global.oppTok,g:e.global.globalTok});return 1;},
 diag:function(){var R=window.__vtRng;var o={keys:Object.keys(R)};
  try{o.sites=R.dumpSites?R.dumpSites():null;}catch(e){o.sitesErr=String(e.message||e);}
  try{o.seq=R.dump?R.dump():null;}catch(e){}
  return o;}};return 1;})()`;
async function run(m){await m.clearControl();await m.eval(INSTALL);
 for(let i=0;i<FRAMES;i++){await m.pump(1,{yieldMs:0});await m.eval('window.__p.tick()');}
 return {buf:JSON.parse(await m.eval('JSON.stringify(window.__p.buf)')),diag:JSON.parse(await m.eval('JSON.stringify(window.__p.diag())'))};}
(async()=>{const A=new Match();
 try{ await A.open({humanIds:['tank_a'],aiCount:2,vantCount:0,rng:'record',rngMode:'record'}); }
 catch(e){ console.log('OPEN_RECORD_ERR '+String(e.message||e)); }
 const rec=await run(A);
 const sites=await A.eval('JSON.stringify(window.__p.diag().sites)');
 const seq=await A.eval('JSON.stringify(window.__p.diag().seq)');
 await A.close();
 const SL=sites?JSON.parse(sites):null, QL=seq?JSON.parse(seq):null;
 const B=new Match(); let openedB=false,errB=null;
 try{ await B.open({humanIds:['tank_a'],aiCount:2,vantCount:0,rngSites:SL,rngSeq:QL}); openedB=true; }catch(e){ errB=String(e.message||e); }
 let rep=null; if(openedB){ rep=await run(B); await B.close(); }
 let firstBad=-1,badN=0;
 if(rep){ for(let i=0;i<Math.max(rec.buf.length,rep.buf.length);i++){ if(!rec.buf[i]||!rep.buf[i]||JSON.stringify(rec.buf[i].opp)!==JSON.stringify(rep.buf[i].opp)){badN++;if(firstBad<0)firstBad=i;} } }
 const out={sitesType:typeof SL,sitesLen:(SL&&SL.length)||null,sitesSample:(SL&&SL.length)?SL.slice(0,2):null,
  seqLen:(QL&&QL.length)||null,openedB:openedB,errB:errB,frames:FRAMES,
  firstBadTick:firstBad,badN:badN,
  tick0:rep?{rec:rec.buf[0].opp,rep:rep.buf[0].opp}:null,
  tick0GlobalSame:rep?JSON.stringify(rec.buf[0].g)===JSON.stringify(rep.buf[0].g):null,
  firstBadDetail:(rep&&firstBad>=0)?{fieldDiffIdx:(function(){var a=rec.buf[firstBad].opp,b=rep.buf[firstBad].opp;for(var i=0;i<Math.max(a.length,b.length);i++){if(a[i]!==b[i])return{i:i,rec:a[i],rep:b[i]};}return null;})()}:null};
 console.log('PS '+JSON.stringify(out).slice(0,1400));
 fs.writeFileSync('D:/vt_run/datasets/ps_'+TAG+'.json',JSON.stringify(out));
})();
