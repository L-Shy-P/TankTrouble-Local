const fs=require('fs');const {Match}=require('./match');
const FRAMES=Number(process.env.FRAMES||1500), SAMPLE=Number(process.env.SAMPLE||50), TAG=process.env.TAG||'wd';
const INSTALL=`(()=>{window.__w={prev:{},shots:{},frames:0,deaths:0,
 ad:()=>VantageSandbox.createAdapter(GameManager.getGameController(),'tank_a'),
 ids:function(){var tk=window.__w.ad().getTanks();return Object.keys(tk);},
 step:function(){var ad=window.__w.ad(),tk=ad.getTanks();window.__w.frames++;
  for(var k in tk){var t=tk[k],f=false;try{f=!!(t.getFireDown&&t.getFireDown());}catch(e){}
   if(f&&!window.__w.prev[k])window.__w.shots[k]=(window.__w.shots[k]||0)+1;
   var h=null;try{h=(typeof t.getHealth==='function')?t.getHealth():null;}catch(e){}
   if(window.__w.prevH===undefined)window.__w.prevH={};
   if(h!==null&&h!==undefined&&window.__w.prevH[k]!==undefined&&h<window.__w.prevH[k])window.__w.deaths++;
   if(h!==null&&h!==undefined)window.__w.prevH[k]=h;
   window.__w.prev[k]=f;}
  return 1;},
 diag:function(){var R=window.__vtRng,o={};
  try{var uc=R.useCounts?R.useCounts():{};var calls=0;for(var k in uc)calls+=uc[k];o.calls=calls;o.sites=Object.keys(uc).length;}catch(e){}
  try{var d=R.dump?R.dump():[];o.values=d?d.length:0;}catch(e){}
  try{var gc=GameManager.getGameController();o.celeb=!!gc.celebrationEnded;}catch(e){}
  o.shots=window.__w.shots;o.deaths=window.__w.deaths;o.frames=window.__w.frames;
  var tk=window.__w.ad().getTanks(),alive={};for(var k2 in tk){try{alive[k2]=tk[k2].getIsAlive?!!tk[k2].getIsAlive():null;}catch(e){}}
  o.alive=alive;return JSON.stringify(o);},
 tree:function(){try{var t=(typeof VantageTree.getTree==='function')?VantageTree.getTree():null;if(!t)return JSON.stringify({empty:true});
  var o={empty:false};try{o.nodes=JSON.stringify(VantageTree.collectAgentNodes(t)).length;}catch(e){o.collectErr=String(e.message||e);}
  try{o.plan=JSON.stringify(VantageTree.getDesiredOperation(t)).slice(0,200);}catch(e){o.planErr=String(e.message||e);}
  return JSON.stringify(o);}catch(e){return JSON.stringify({err:String(e.message||e)});}}};return 1;})()`;
(async()=>{const m=new Match();await m.open({humanIds:['tank_a'],aiCount:2,vantCount:1,rng:'record',rngMode:'record'});
 await m.eval(INSTALL); const series=[];let treeInfo=null;
 for(let i=1;i<=FRAMES;i++){ await m.pump(1,{yieldMs:0}); await m.eval('window.__w.step()');
  if(i%SAMPLE===0){ const d=JSON.parse(await m.eval('window.__w.diag()')); series.push({f:i,calls:d.calls,values:d.values,celeb:d.celeb}); }
  if(!treeInfo&&i%25===0){ const t=JSON.parse(await m.eval('window.__w.tree()')); if(!t.empty&&!t.err&&!t.collectErr)treeInfo={atFrame:i,info:t}; } }
 const final=JSON.parse(await m.eval('window.__w.diag()'));
 const out={tag:TAG,frames:FRAMES,final:{calls:final.calls,values:final.values,sites:final.sites,shots:final.shots,deaths:final.deaths,alive:final.alive,celeb:final.celeb},
  series:series, treeInfo:treeInfo, ratio:(final.values/final.calls).toFixed(2)};
 console.log('WD '+JSON.stringify(out).slice(0,1800));
 fs.writeFileSync('D:/vt_run/datasets/wd_'+TAG+'.json',JSON.stringify(out));
 await m.close();})();
