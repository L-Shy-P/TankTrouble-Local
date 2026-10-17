const fs=require('fs'),path=require('path'),crypto=require('crypto');const {Match}=require('./match');
const FRAMES=Number(process.env.FRAMES||90), TAG=process.env.TAG||'v6', OUT=process.env.OUT||'D:/vt_run/datasets';
const INSTALL=`(()=>{window.__z={old:[],n:0,ids:null,a:null,nw:null,aBytes:0,aN:0,aSer:[],maxA:0,
 ad:()=>VantageSandbox.createAdapter(GameManager.getGameController(),'tank_a'),
 hash:function(a){var h=2166136261;for(var i=0;i<a.length;i++){h^=(a[i]|0);h=(h*16777619)>>>0;}return h;},
 read:function(pid){var t=window.__z.ad().getTanks()[pid];if(!t)return null;var f=function(n,d){try{return typeof t[n]==='function'?!!t[n]():d;}catch(e){return d;}};
  return [f('getForward'),f('getBack'),f('getLeft'),f('getRight'),f('getFireDown'),f('getLocked')];},
 pack:function(a){var v=0;for(var i=0;i<6;i++)if(a[i])v|=(1<<i);return v;},
 start:function(){window.__z.a=window.__z.ad();try{window.__z.a.startRecording();return 'started';}catch(e){return 'err';}},
 tick:function(){var ad=window.__z.ad();var e=VantageObserve.encode({adapter:ad,tree:null,horizonSec:10,K_death:1,frameDt:1/60});
  var ids=window.__z.ids||(window.__z.ids=(function(){var tk=ad.getTanks(),o=[];for(var k in tk)if(k!=='tank_a')o.push(k);return o;})());
  var p={t:window.__z.n,d:e.dims.total,h:window.__z.hash(e.global.globalTok.concat(e.global.oppTok)),acts:{},packed:{}};
  for(var i=0;i<ids.length;i++){var pid=ids[i];p.acts[pid]=window.__z.read(pid);p.packed[pid]=window.__z.pack(p.acts[pid]);}
  window.__z.old.push(p); window.__z.a.recordFrame(p); window.__z.n++;
  if(window.__z.n%60===0){ try{var t=(typeof VantageTree.getTree==='function')?VantageTree.getTree():null;
    if(t){var a=VantageTree.collectAgentNodes(t);var s=JSON.stringify(a);window.__z.aBytes+=s.length;window.__z.aN++;if(s.length>window.__z.maxA)window.__z.maxA=s.length;window.__z.aSer.push(s.length);} }catch(e){} }
  return 1;},
 stop:function(){try{window.__z.nw=window.__z.a.stopRecording();return window.__z.nw?window.__z.nw.length:'null';}catch(e){return 'err:'+String(e.message||e);}},
 dump:function(){return JSON.stringify({nw:window.__z.nw||[],aBytes:window.__z.aBytes,aN:window.__z.aN,aSer:window.__z.aSer,maxA:window.__z.maxA});}};return 1;})()`;
(async()=>{const t0=Date.now();const m=new Match();await m.open({humanIds:['tank_a'],aiCount:2,vantCount:1});
 await m.clearControl();await m.eval(INSTALL);const st=await m.eval('window.__z.start()');
 for(let i=0;i<FRAMES;i++){await m.pump(1,{yieldMs:0});await m.eval('window.__z.tick()');}
 const len=await m.eval('window.__z.stop()');
 const d=JSON.parse(await m.eval('window.__z.dump()'));
 const oldA=JSON.parse(await m.eval('JSON.stringify(window.__z.old)'));
 const p1=path.join(OUT,'round_'+TAG+'.old.jsonl'),p2=path.join(OUT,'round_'+TAG+'.product.jsonl');
 const s1=oldA.map(x=>JSON.stringify(x)).join('\n')+'\n',s2=d.nw.map(x=>JSON.stringify(x)).join('\n')+'\n';
 fs.writeFileSync(p1,s1);fs.writeFileSync(p2,s2);
 const md5=(f)=>crypto.createHash('md5').update(fs.readFileSync(f)).digest('hex');
 let same=true,fd=-1;for(let i=0;i<Math.max(oldA.length,d.nw.length);i++){if(JSON.stringify(oldA[i])!==JSON.stringify(d.nw[i])){same=false;if(fd<0)fd=i;}}
 const out={tag:TAG,frames:FRAMES,started:st,stoppedLen:len,oldLen:oldA.length,newLen:d.nw.length,byteSame:same,firstDiff:fd,
  oldBytes:Buffer.byteLength(s1),productBytes:Buffer.byteLength(s2),oldMd5:md5(p1),productMd5:md5(p2),sameMd5:md5(p1)===md5(p2),
  aSamples:{count:d.aN,bytesTotal:d.aBytes,maxOne:d.maxA,series:d.aSer,per60FrameBytes:(d.aN?Math.round(d.aBytes/d.aN):0)},
  est1200:(d.aN?Math.round(d.aBytes/FRAMES*1200):0),ms:Date.now()-t0};
 fs.writeFileSync(path.join(OUT,'round_'+TAG+'.meta.json'),JSON.stringify(out,null,1));
 console.log('V6 '+JSON.stringify(out).slice(0,1200));})();
