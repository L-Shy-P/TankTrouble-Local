const fs=require('fs');const {Match}=require('./match');
const FRAMES=Number(process.env.FRAMES||60), TAG=process.env.TAG||'v4';
const INSTALL=`(()=>{window.__x={old:[],nw:[],n:0,ids:null,a:null,
 ad:()=>VantageSandbox.createAdapter(GameManager.getGameController(),'tank_a'),
 hash:function(a){var h=2166136261;for(var i=0;i<a.length;i++){h^=(a[i]|0);h=(h*16777619)>>>0;}return h;},
 read:function(pid){var t=window.__x.ad().getTanks()[pid];if(!t)return null;var f=function(n,d){try{return typeof t[n]==='function'?!!t[n]():d;}catch(e){return d;}};
  return [f('getForward'),f('getBack'),f('getLeft'),f('getRight'),f('getFireDown'),f('getLocked')];},
 pack:function(a){var v=0;for(var i=0;i<6;i++)if(a[i])v|=(1<<i);return v;},
 tick:function(){var ad=window.__x.ad();var e=VantageObserve.encode({adapter:ad,tree:null,horizonSec:10,K_death:1,frameDt:1/60});
  var ids=window.__x.ids||(window.__x.ids=(function(){var tk=ad.getTanks(),o=[];for(var k in tk)if(k!=='tank_a')o.push(k);return o;})());
  var all=e.global.globalTok.concat(e.global.oppTok);
  var p={t:window.__x.n,d:e.dims.total,h:window.__x.hash(all),acts:{},packed:{}};
  for(var i=0;i<ids.length;i++){var pid=ids[i];p.acts[pid]=window.__x.read(pid);p.packed[pid]=window.__x.pack(p.acts[pid]);}
  window.__x.old.push(p); window.__x.a.recordFrame(p); window.__x.n++; return 1;},
 start:function(){window.__x.a=window.__x.ad();try{window.__x.a.startRecording();return 'started';}catch(e){return 'err:'+String(e.message||e);}},
 stop:function(){try{window.__x.nw=window.__x.a.stopRecording();return window.__x.nw.length;}catch(e){return 'err:'+String(e.message||e);}},
 death:function(){var ad=window.__x.ad(),o={};['getDeathsCount','getScores','getLastDeathCauses','getLastRoundDeaths','getDeathHookStatus'].forEach(function(n){
  try{o[n]=(typeof ad[n]==='function')?JSON.stringify(ad[n]()).slice(0,150):'absent';}catch(e){o[n]='err:'+String(e.message||e).slice(0,60);}});return JSON.stringify(o);},
 tree:function(){try{var t=(typeof VantageTree.getTree==='function')?VantageTree.getTree():null;if(!t)return JSON.stringify({empty:true});
  var a=VantageTree.collectAgentNodes(t);return JSON.stringify({empty:false,aLen:JSON.stringify(a).length});}catch(e){return JSON.stringify({err:String(e.message||e).slice(0,80)});}}};return 1;})()`;
(async()=>{const t0=Date.now();const m=new Match();await m.open({humanIds:['tank_a'],aiCount:2,vantCount:1});
 await m.clearControl(); await m.eval(INSTALL); const started=await m.eval('window.__x.start()');
 let aLen=null,treeAt=null;
 for(let i=0;i<FRAMES;i++){ await m.pump(1,{yieldMs:0}); await m.eval('window.__x.tick()');
  if(aLen===null&&i%20===0){const t=JSON.parse(await m.eval('window.__x.tree()'));if(!t.empty&&!t.err){aLen=t.aLen;treeAt=i;}} }
 const stopped=await m.eval('window.__x.stop()'); const death=JSON.parse(await m.eval('window.__x.death()'));
 const oldA=JSON.parse(await m.eval('JSON.stringify(window.__x.old)'));
 const nwA=JSON.parse(await m.eval('JSON.stringify(window.__x.nw||[])'));
 let same=null,firstDiff=-1; if(nwA&&nwA.length){ same=true; for(let i=0;i<Math.max(oldA.length,nwA.length);i++){const a=oldA[i],b=nwA[i];if(!a||!b||a.h!==b.h||JSON.stringify(a.packed)!==JSON.stringify(b.packed)){same=false;if(firstDiff<0)firstDiff=i;}} }
 const out={tag:TAG,frames:FRAMES,started:started,stoppedLen:(typeof stopped==='number'?stopped:stopped),oldLen:oldA.length,newLen:nwA.length,
  same:same,firstDiff:firstDiff,aLen:aLen,treeAt:treeAt,death:death,ms:Date.now()-t0};
 console.log('V4 '+JSON.stringify(out).slice(0,1400));
 fs.writeFileSync('D:/vt_run/datasets/v4_'+TAG+'.json',JSON.stringify(out)); await m.close();})();
