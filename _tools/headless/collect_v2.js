const fs=require('fs'),path=require('path');const {Match}=require('./match');
const TAG=process.env.TAG||('c'+process.pid), FRAMES=Number(process.env.FRAMES||600);
const OUT=process.env.OUT||'D:/vt_run/datasets';
const LOG='/tmp/collect_'+TAG+'.log';
function log(){const s=new Date().toISOString()+' '+Array.prototype.join.call(arguments,' ')+'\n';try{fs.appendFileSync(LOG,s);}catch(e){}try{process.stdout.write(s);}catch(e){}}
process.on('uncaughtException',e=>{log('UNCAUGHT '+String(e&&e.stack||e));process.exitCode=9;});
process.on('unhandledRejection',e=>{log('UNHANDLED '+String(e&&e.stack||e));process.exitCode=8;});
process.on('exit',c=>{log('EXIT code='+c+' uptime='+process.uptime().toFixed(1));});
const INSTALL=`(()=>{window.__c2={buf:[],n:0,hash:function(a){var h=2166136261;for(var i=0;i<a.length;i++){h^=(a[i]|0);h=(h*16777619)>>>0;}return h;},
 tick:function(){var gc=GameManager.getGameController();var ad=VantageSandbox.createAdapter(gc,'tank_a');
   var enc=VantageObserve.encode({adapter:ad,tree:window.VantageTree||null,horizonSec:10,K_death:1,frameDt:1/60});
   var ts=ad.getTankState()||{};var act=[ts.forward?1:0,ts.back?1:0,ts.left?1:0,ts.right?1:0,ts.fireDown?1:0,ts.locked?1:0];
   var all=enc.global.globalTok.concat(enc.global.oppTok||[]);
   window.__c2.buf.push({t:window.__c2.n++,d:enc.dims.total,h:window.__c2.hash(all),a:act});
   return enc.dims.total;}};return 1;})()`;
(async()=>{const t0=Date.now();const m=new Match();
  await m.open({humanIds:['tank_a'],aiCount:2,vantCount:0,rng:'flat',rngMode:'flat'});
  const tOpen=Date.now(); await m.clearControl(); await m.eval(INSTALL);
  const dim=await m.eval('window.__c2.tick()');
  const t1=Date.now(); await m.pump(FRAMES,{yieldMs:0},{onFrame:1}).catch(()=>{});
  const t2=Date.now();
  const dump=await m.eval('JSON.stringify(window.__c2.buf)');
  const seq=await m.eval('JSON.stringify(window.__vtRng.dump())');
  fs.writeFileSync(path.join(OUT,'round_'+TAG+'.jsonl'),dump.split('},{').join('}\n{').replace(/^\[/,'').replace(/\]$/,'')+'\n');
  fs.writeFileSync(path.join(OUT,'round_'+TAG+'.rng.json'),seq);
  const buf=JSON.parse(dump), rng=JSON.parse(seq);
  log('DONE dim='+dim+' ticks='+buf.length+' openMs='+(tOpen-t0)+' pumpMs='+(t2-t1)+' jsonlBytes='+fs.statSync(path.join(OUT,'round_'+TAG+'.jsonl')).size+' rngBytes='+fs.statSync(path.join(OUT,'round_'+TAG+'.rng.json')).size+' rngN='+rng.length+' firstHash='+(buf[0]?buf[0].h:null)+' lastHash='+(buf[buf.length-1]?buf[buf.length-1].h:null));
  await m.close();})();
