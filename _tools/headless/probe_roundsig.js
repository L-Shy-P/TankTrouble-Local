const fs=require('fs');const {Match}=require('./match');
const SRC=fs.readFileSync(__dirname+'/inject_roundsig.js','utf8');
(async()=>{const m=new Match();
 await m.open({humanIds:['tank_a'],aiCount:2,vantCount:1});
 await m.clearControl(); console.log('EVAL '+String(await m.eval(SRC)).slice(0,20));
 let first=null;
 for(let i=0;i<3600;i++){ const r=String(await m.eval('window.__rs.step('+i+')'));
  if(i===0) first=r; }
 console.log('FRAME0 '+String(first).slice(0,120));
 console.log('SIG '+String(await m.eval('window.__rs.stat()')).slice(0,420));
 await m.close();})();
