const fs=require('fs'),path=require('path'),crypto=require('crypto');const {Match}=require('./match');
const FRAMES=Number(process.env.FRAMES||60), TAG=process.env.TAG||'v5', OUT=process.env.OUT||'D:/vt_run/datasets';
const USE_PRODUCT=process.env.VT_USE_PRODUCT_CHANNEL==='1';
const INSTALL=`(()=>{window.__y={old:[],n:0,ids:null,a:null,
 ad:()=>VantageSandbox.createAdapter(GameManager.getGameController(),'tank_a'),
 hash:function(a){var h=2166136261;for(var i=0;i<a.length;i++){h^=(a[i]|0);h=(h*16777619)>>>0;}return h;},
 read:function(pid){var t=window.__y.ad().getTanks()[pid];if(!t)return null;var f=function(n,d){try{return typeof t[n]==='function'?!!t[n]():d;}catch(e){return d;}};
  return [f('getForward'),f('getBack'),f('getLeft'),f('getRight'),f('getFireDown'),f('getLocked')];},
 pack:function(a){var v=0;for(var i=0;i<6;i++)if(a[i])v|=(1<<i);return v;},
 start:function(){window.__y.a=window.__y.ad();try{window.__y.a.startRecording();return 'started';}catch(e){return 'err:'+String(e.message||e);}},
 tick:function(){var ad=window.__y.ad();var e=VantageObserve.encode({adapter:ad,tree:null,horizonSec:10,K_death:1,frameDt:1/60});
  var ids=window.__y.ids||(window.__y.ids=(function(){var tk=ad.getTanks(),o=[];for(var k in tk)if(k!=='tank_a')o.push(k);return o;})());
  var p={t:window.__y.n,d:e.dims.total,h:window.__y.hash(e.global.globalTok.concat(e.global.oppTok)),acts:{},packed:{}};
  for(var i=0;i<ids.length;i++){var pid=ids[i];p.acts[pid]=window.__y.read(pid);p.packed[pid]=window.__y.pack(p.acts[pid]);}
  window.__y.old.push(p); window.__y.a.recordFrame(p); window.__y.n++; return 1;},
 stop:function(){try{return window.__y.a.stopRecording().length;}catch(e){return 'err';}},
 meta:function(){var o={};var ad=window.__y.ad();
  ['getDeathsCount','getLastDeathCauses','getLastDeathCauseSeq','getLastRoundDeaths','getDeathHookStatus','getScores'].forEach(function(n){
   try{o[n]=(typeof ad[n]==='function')?ad[n]():null;}catch(e){o[n]='err:'+String(e.message||e).slice(0,60);}});
  return JSON.stringify(o);}};return 1;})()`;
(async()=>{const t0=Date.now();const m=new Match();await m.open({humanIds:['tank_a'],aiCount:2,vantCount:1});
 await m.clearControl();await m.eval(INSTALL);const st=await m.eval('window.__y.start()');
 for(let i=0;i<FRAMES;i++){await m.pump(1,{yieldMs:0});await m.eval('window.__y.tick()');}
 const len=await m.eval('window.__y.stop()');const meta=JSON.parse(await m.eval('window.__y.meta()'));
 const oldA=JSON.parse(await m.eval('JSON.stringify(window.__y.old)'));const nwA=JSON.parse(await m.eval('JSON.stringify(window.__y.a&&window.__y.a._recordBuffer?window.__y.a._recordBuffer:[])'));
 const p1=path.join(OUT,'round_'+TAG+'.old.jsonl'),p2=path.join(OUT,'round_'+TAG+'.product.jsonl');
 const s1=oldA.map(x=>JSON.stringify(x)).join('\n')+'\n',s2=nwA.map(x=>JSON.stringify(x)).join('\n')+'\n';
 fs.writeFileSync(p1,s1);fs.writeFileSync(p2,s2);
 const md5=(f)=>crypto.createHash('md5').update(fs.readFileSync(f)).digest('hex');
 let byteSame=true,fd=-1;for(let i=0;i<Math.max(oldA.length,nwA.length);i++){if(JSON.stringify(oldA[i])!==JSON.stringify(nwA[i])){byteSame=false;if(fd<0)fd=i;}}
 const metaOut={tag:TAG,frames:FRAMES,channel:USE_PRODUCT?'product':'legacy(dry-run: both collected)','productStart':st,'productLen':len,
  oldLen:oldA.length,byteSame:byteSame,firstDiff:fd,
  files:{old:p1,product:p2,oldBytes:Buffer.byteLength(s1),productBytes:Buffer.byteLength(s2),oldMd5:md5(p1),productMd5:md5(p2)},
  deathApi:{deathsCount:meta.getDeathsCount,lastRoundDeaths:meta.getLastRoundDeaths,lastDeathCauses:(meta.getLastDeathCauses||[]).length,
   hookStatus:meta.getDeathHookStatus,scoresType:typeof meta.getScores},
  ms:Date.now()-t0};
 fs.writeFileSync(path.join(OUT,'round_'+TAG+'.meta.json'),JSON.stringify(metaOut,null,1));
 console.log('V5 '+JSON.stringify({byteSame:byteSame,firstDiff:fd,oldBytes:metaOut.files.oldBytes,productBytes:metaOut.files.productBytes,
  sameMd5:(metaOut.files.oldMd5===metaOut.files.productMd5),deaths:metaOut.deathApi.deathsCount,hook:JSON.stringify(metaOut.deathApi.hookStatus).slice(0,140),ms:metaOut.ms}));
})();
