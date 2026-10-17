const fs=require('fs');const {Match}=require('./match');
const tag=process.env.TAG||('w'+process.pid), N=Number(process.env.ROUNDS||6);
const logf=process.env.LOG||('/tmp/rw_'+tag+'.log');
function log(){const s=new Date().toISOString()+' '+Array.prototype.join.call(arguments,' ')+'\n';try{fs.appendFileSync(logf,s);}catch(e){}}
log('START pid='+process.pid+' tag='+tag);
process.on('uncaughtException',e=>{log('UNCAUGHT '+String(e&&e.stack||e));process.exitCode=9;});
process.on('unhandledRejection',e=>{log('UNHANDLED '+String(e&&e.stack||e));process.exitCode=8;});
process.on('exit',c=>{log('EXIT code='+c+' uptime='+process.uptime().toFixed(1));});
(async()=>{const t0=Date.now();const m=new Match();let ok=false;
 for(let t=0;t<3&&!ok;t++){try{await m.open({humanIds:['tank_a'],aiCount:1,vantCount:0});ok=true;log('OPEN ok try='+t);}catch(e){log('OPEN fail try='+t+' '+String(e.message||e));}}
 if(!ok){log('GIVEUP');process.exitCode=7;return;}
 const times=[];for(let i=0;i<N;i++){const a=Date.now();await m.pump(600,{yieldMs:0});times.push(Date.now()-a);}
 const t2=Date.now();try{await m.close();}catch(e){log('CLOSE err '+String(e.message||e));}
 log('DONE total='+(t2-t0)+' times='+JSON.stringify(times));})();
