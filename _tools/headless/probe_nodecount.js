const fs=require('fs');const {Match}=require('./match');
const SRC=fs.readFileSync(__dirname+'/inject_nodecount.js','utf8');
(async()=>{const m=new Match();
 await m.open({humanIds:['tank_a'],aiCount:2,vantCount:1});
 await m.clearControl(); await m.eval(SRC); await m.eval('window.__nc.start()');
 await m.pump(600,{yieldMs:0});
 console.log('NODECOUNT '+String(await m.eval('window.__nc.stat()')).slice(0,200));
 await m.close();})();
