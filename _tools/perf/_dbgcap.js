const fs=require('fs'),path=require('path');
const { Match } = require('../headless/match');
const SRC = fs.readFileSync(require('path').join(__dirname,'..','headless','_g1_inject.js'),'utf8');
(async()=>{
 const m=new Match();
 await m.open({players:8,storm:false,control:false});
 await m.eval(SRC); await m.eval('window.__g1.subscribe()'); await m.eval('window.__g1.setup()'); await m.eval('window.__g1.setFire(1)');
 const meta=JSON.parse(await m.eval('JSON.stringify(window.__g1.meta())'));
 console.log('meta', JSON.stringify({vid:meta.vid,states:meta.states}));
 for(let f=0;f<420;f++){
   const o=JSON.parse(await m.eval('window.__g1.step(0)'));
   if(o.err){console.log('ERR',o.err);break;}
   if(f%40===0) console.log('f',f,'N',o.N,'state',JSON.stringify(o.state),'tv',JSON.stringify(o.tv),'iface',JSON.stringify(o.iface),'bullets',o.segRows&&o.segRows.bullet);
   await m.pump(1);
 }
 await m.close();
})().catch(e=>{console.error(e);process.exit(1)});
