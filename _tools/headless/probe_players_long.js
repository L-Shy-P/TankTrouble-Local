const fs=require('fs');const {Match}=require('./match');
const SRC=fs.readFileSync(__dirname+'/inject_players.js','utf8');
(async()=>{const t0=Date.now();const m=new Match();
 await m.open({humanIds:['tank_a'],aiCount:2,vantCount:1});
 await m.clearControl(); await m.eval(SRC);
 console.log('INFO '+String(await m.eval('window.__probe.setup()')).slice(0,220));
 let evSeen=false;
 for(let i=0;i<3600;i++){ await m.eval('window.__probe.step('+i+')'); await m.pump(1,{yieldMs:0});
  if((i+1)%600===0){ const s=String(await m.eval('window.__probe.stat()'));
   console.log('S'+(i+1)+' '+s.slice(0,340));
   if(s.indexOf('ROUND_ENDED')>=0&&s.indexOf('evt')>=0){ /* keep going to see sequence */ } }
  }
 console.log('FINAL '+String(await m.eval('window.__probe.stat()')).slice(0,500));
 console.log('WALL_MS '+(Date.now()-t0));
 await m.close();})();
