const fs=require('fs');const {Match}=require('./match');
const CAP=Number(process.env.CAP||10000), TAG=process.env.TAG||'fm', SAMPLE=Number(process.env.SAMPLE||20);
const SNAP=`(function(){var R=window.__vtRng,o={};
 try{var uc=R.useCounts?R.useCounts():null;var t=0;if(uc)for(var k in uc)t+=uc[k];o.n=t;}catch(e){o.n=-1;}
 try{var gc=GameManager.getGameController();o.celeb=!!gc.celebrationEnded;o.rounds=(gc.roundEventListeners&&Object.keys(gc.roundEventListeners).length)||0;}catch(e){o.celebErr=String(e.message||e);}
 return JSON.stringify(o);})()`;
(async()=>{const m=new Match();await m.open({humanIds:['tank_a'],aiCount:2,vantCount:1,rng:'record',rngMode:'record'});
 const snap=async()=>JSON.parse(await m.eval(SNAP));
 const s0=await snap(); const series=[{f:0,...s0}];
 const probe=JSON.parse(await m.eval(`(function(){var o={};
  try{o.tree=Object.keys(window.VantageTree).length;o.canCollect=typeof window.VantageTree.collectAgentNodes;o.canPlan=typeof window.VantageTree.getDesiredOperation;}catch(e){o.treeErr=String(e.message||e);}
  try{var t=(typeof window.VantageTree.getTree==='function')?window.VantageTree.getTree():null;o.treeObj=!!t;
   if(t&&typeof window.VantageTree.collectAgentNodes==='function'){var a=window.VantageTree.collectAgentNodes(t);o.ASample=JSON.stringify(a).slice(0,200);}
   if(t&&typeof window.VantageTree.getDesiredOperation==='function'){var p=window.VantageTree.getDesiredOperation(t);o.Plan=JSON.stringify(p).slice(0,200);}
  }catch(e){o.callErr=String(e.message||e);}
  return JSON.stringify(o);})()`));
 let f=0,ended=-1;
 for(let i=1;i<=CAP;i++){ await m.pump(1,{yieldMs:0}); f=i;
  if(i%SAMPLE===0){ const s=await snap(); series.push({f:i,...s});
   if(s.celeb&&ended<0){ended=i;break;} } }
 const last=series[series.length-1];
 const bursts=[];for(let i=1;i<series.length;i++){const d=series[i].n-series[i-1].n;if(d>SAMPLE*150)bursts.push({f:series[i].f,delta:d});}
 const out={tag:TAG,framesRun:f,cap:CAP,endedAt:ended,totalValues:last.n,totalBytes:last.n*8,
  burstsN:bursts.length,bursts:bursts.slice(0,8),bytesPerBurst:bursts.length?(bursts.reduce((a,b)=>a+b.delta,0)*8/bursts.length).toFixed(0):0,
  probe:probe,celebSeries:series.filter(x=>x.celeb).slice(0,3),roundsCount:last.rounds};
 console.log('FULL '+JSON.stringify(out).slice(0,1700));
 fs.writeFileSync('D:/vt_run/datasets/full_'+TAG+'.json',JSON.stringify(out));
 await m.close();})();
