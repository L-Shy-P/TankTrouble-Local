const fs=require('fs');const {Match}=require('./match');
const SRC=fs.readFileSync(__dirname+'/inject_players.js','utf8');
(async()=>{const m=new Match();
 await m.open({humanIds:['tank_a'],aiCount:2,vantCount:1});
 await m.clearControl(); await m.eval(SRC);
 console.log('INFO '+String(await m.eval('window.__probe.setup()')).slice(0,400));
 for(let i=0;i<900;i++){ await m.eval('window.__probe.step('+i+')'); await m.pump(1,{yieldMs:0});
  if(i===299||i===899) console.log('S'+i+' '+String(await m.eval('window.__probe.stat()')).slice(0,400)); }
 await m.close();})();
