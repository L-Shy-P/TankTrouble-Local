const fs=require('fs');const {Match}=require('./match');
const FRAMES=Number(process.env.FRAMES||300), TAG=process.env.TAG||'df';
const INSTALL=`(()=>{window.__d={buf:[],n:0,hash:function(a){var h=2166136261;for(var i=0;i<a.length;i++){h^=(a[i]|0);h=(h*16777619)>>>0;}return h;},
 tick:function(){var gc=GameManager.getGameController();var ad=VantageSandbox.createAdapter(gc,'tank_a');
  var e=VantageObserve.encode({adapter:ad,tree:null,horizonSec:10,K_death:1,frameDt:1/60});var g=e.global;
  var nh=window.__d.hash(e.nodes.tokens.reduce(function(a,x){return a.concat(x);},[]));
  window.__d.buf.push({t:window.__d.n++,g:g.globalTok,opp:g.oppTok,col:g.colTok,mine:g.mineTok,storm:e.storm.stormTok,nh:nh,dims:e.dims});
  return 1;}};return 1;})()`;
async function run(m){await m.clearControl();await m.eval(INSTALL);for(let i=0;i<FRAMES;i++){await m.pump(1,{yieldMs:0});await m.eval('window.__d.tick()');}return JSON.parse(await m.eval('JSON.stringify(window.__d.buf)'));}
(async()=>{const A=new Match();await A.open({humanIds:['tank_a'],aiCount:2,vantCount:0,rng:'flat',rngMode:'flat'});
 const names=JSON.parse(await A.eval('JSON.stringify({g:VantageObserve.GLOBAL_FIELDS,o:VantageObserve.OPP_FIELDS})'));
 const rec=await run(A);const seq=await A.eval('JSON.stringify(window.__vtRng.dump())');await A.close();
 const B=new Match();await B.open({humanIds:['tank_a'],aiCount:2,vantCount:0,rngSeq:JSON.parse(seq)});
 const rep=await run(B);await B.close();
 const cmp=(t)=>{const a=rec[t],b=rep[t];if(!a||!b)return{err:'missing tick '+t};
  const dg=[];for(let i=0;i<Math.max(a.g.length,b.g.length);i++){if(a.g[i]!==b.g[i])dg.push({i:i,f:names.g[i]||'?',rec:a.g[i],rep:b.g[i]});}
  const dopp=[];for(let i=0;i<Math.max(a.opp.length,b.opp.length);i++){if(a.opp[i]!==b.opp[i])dopp.push({i:i,f:names.o[i%names.o.length]||'?',rec:a.opp[i],rep:b.opp[i]});}
  const seg=(x,y,label)=>[(x&&x.length)!==(y&&y.length)?{seg:label,lenRec:x&&x.length,lenRep:y&&y.length}:(JSON.stringify(x)===JSON.stringify(y)?null:{seg:label,diff:'values differ'})].filter(Boolean);
  return {tick:t,gDiffs:dg.slice(0,4),gDiffN:dg.length,oppDiffs:dopp.slice(0,4),oppDiffN:dopp.length,
          segDiffs:[].concat(seg(a.col,b.col,'col'),seg(a.mine,b.mine,'mine'),seg(a.storm,b.storm,'storm')),
          nodeHashSame:(a.nh===b.nh),dimsRec:a.dims,dimsRep:b.dims};};
 const out={firstDiff:cmp(27),secondDiff:cmp(28),tickCounts:[rec.length,rep.length]};
 console.log('DIFF '+JSON.stringify(out).slice(0,1800));
 fs.writeFileSync('D:/vt_run/datasets/diff_'+TAG+'.json',JSON.stringify(out));
})();
