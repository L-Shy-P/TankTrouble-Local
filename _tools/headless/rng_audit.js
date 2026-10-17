const fs=require('fs');const {Match}=require('./match');
const FRAMES=Number(process.env.FRAMES||120), TAG=process.env.TAG||'au';
const INSTALL=`(()=>{window.__g={n:0,snap:[],
 step:function(){window.__g.n++;return 1;},
 uc:function(){var R=window.__vtRng,o={};try{o.uc=R.useCounts?R.useCounts():null;}catch(e){}try{o.seq=R.dump?R.dump():null;}catch(e){}return o;}};return 1;})()`;
(async()=>{const m=new Match();await m.open({humanIds:['tank_a'],aiCount:2,vantCount:0,rng:'record',rngMode:'record'});
 await m.eval(INSTALL);
 const ucs=[];
 for(let i=0;i<FRAMES;i++){ await m.pump(1,{yieldMs:0}); await m.eval('window.__g.n=window.__g.n+1');
  if(i%10===9||i===0){ const s=JSON.parse(await m.eval('JSON.stringify(window.__g.uc())')); ucs.push({frame:i+1,uc:s.uc,seqLen:(s.seq?s.seq.length:0)}); } }
 const final=JSON.parse(await m.eval('JSON.stringify(window.__g.uc())'));
 const uc=final.uc||{},seq=final.seq||[];
 const tot=Object.values(uc).reduce((a,b)=>a+b,0);
 const rows=Object.entries(uc).map(([k,v])=>({site:k,n:v,bytes:v*8,pct:(100*v/Math.max(1,tot)).toFixed(1)})).sort((a,b)=>b.n-a.n);
 let zeros=0,ones=0,ints=0,distinct=new Set(),dups=0;
 for(let i=0;i<seq.length;i++){const v=seq[i];distinct.add(v);if(v===0)zeros++;if(v===1)ones++;if(Number.isInteger(v))ints++;if(i>0&&seq[i]===seq[i-1])dups++;}
 const perFrame=ucs.map(x=>x.seqLen);
 const inc=[];for(let i=1;i<perFrame.length;i++)inc.push(perFrame[i]-perFrame[i-1]);
 console.log('AUDIT '+JSON.stringify({frames:FRAMES,totalValues:seq.length,totalBytes:seq.length*8,perFrameAvg:(seq.length/FRAMES).toFixed(1),
  topSites:rows.slice(0,8),siteN:rows.length,
  seqStats:{distinct:distinct.size,zeros:zeros,ones:ones,zeroOrOne:zeros+ones,ints:ints,dupConsec:dups,
    pctZeroOrOne:(100*(zeros+ones)/Math.max(1,seq.length)).toFixed(1),pctInt:(100*ints/Math.max(1,seq.length)).toFixed(1)},
  checkpointSeqLens:perFrame,perCheckpointIncrements:inc}));
 fs.writeFileSync('D:/vt_run/datasets/audit_'+TAG+'.json',JSON.stringify({rows:rows.slice(0,20),seqStats:{distinct:distinct.size,zeros:zeros,ones:ones,ints:ints,dups:dups},perFrame:perFrame,total:seq.length}));
 await m.close();})();
