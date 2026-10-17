const fs=require('fs');const {Match}=require('./match');
const SRC=fs.readFileSync(__dirname+'/inject_fire.js','utf8');
(async()=>{const m=new Match();
 await m.open({humanIds:['tank_a'],aiCount:1,vantCount:1});
 await m.clearControl();
 let inst='n/a'; try{ await m.installControl('tank_a'); inst='ok'; }catch(e){ inst='err'; }
 await m.eval(SRC); await m.eval('window.__probe.setup()');
 for(let i=0;i<400;i++){ await m.eval('window.__probe.step()'); await m.pump(1,{yieldMs:0}); }
 const fi=JSON.parse(await m.eval('JSON.stringify(window.__fi)'));
 let pc='n/a'; try{ pc=await m.projectileCount(); }catch(e){}
 console.log('INSTALL '+inst+'  LAST_X='+fi.last+'  maxProj='+fi.maxProj+'  framesWithProj='+fi.seen+'  matchProjCount='+JSON.stringify(pc)+'  err='+fi.err);
 const g=JSON.parse(await m.eval('JSON.stringify({callsA:(window.__vantageIface||{}).callsA,picks:(window.__vantageIface||{}).picks,skipped:(window.__vantageIface||{}).skipped})'));
 console.log('IFACE '+JSON.stringify(g));
 await m.close();})();
