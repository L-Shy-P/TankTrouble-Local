const {Match}=require('./match');
(async()=>{const m=new Match();
 await m.open({humanIds:['tank_a'],aiCount:2,vantCount:1});
 await m.clearControl();
 let inst='n/a';
 try{ const r=await m.installControl('tank_a'); inst='ok'; }catch(e){ inst='err:'+String(e.message||e).slice(0,60); }
 await m.eval(`(function(){window.__f={fired:0,types:{}};try{var gc=GameManager.getGameController();
   gc.addRoundEventListener(function(self,id,evt,data){if(String(evt)==='weapon fired')window.__f.fired++;},window.__f);}catch(e){}
   return 'ok';})()`);
 let moved=false;
 try{ const p0=await m.myTank(); await m.setControl({fwd:true}); await m.pump(10,{yieldMs:4});
      const p1=await m.myTank(); moved=!!(p1&&p0&&Math.hypot(p1.x-p0.x,p1.y-p0.y)>0.5); }catch(e){ moved='err:'+String(e.message||e).slice(0,40); }
 await m.clearControl();
 for(let i=0;i<600;i++){
   if(i%20===0) await m.eval(`(function(){try{var gc=GameManager.getGameController();var rm=gc.getRoundModel?gc.getRoundModel():null;
     if(!rm||!rm.getProjectiles)return 0;var ps=rm.getProjectiles();var ks=Object.keys(ps);
     for(var j=0;j<ks.length;j++){var p=ps[ks[j]];var t=(p&&p.getType)?String(p.getType()):'?';
       window.__f.types[t]=(window.__f.types[t]||0)+1;}}catch(e){}return 1;})()`);
   try{ await m.setControl(i%4<2?{fwd:true,left:true}:{fwd:true,right:true}); }catch(e){}
   await m.pump(1,{yieldMs:0});
 }
 await m.clearControl();
 const f=JSON.parse(await m.eval('JSON.stringify(window.__f)'));
 const W=await m.eval("(function(){try{return JSON.stringify(Constants.WEAPON_TYPES)}catch(e){return 'null'}})()");
 console.log('INSTALL '+inst+'  MOVED '+JSON.stringify(moved));
 console.log('FIRE fired='+f.fired+'  types='+JSON.stringify(f.types));
 console.log('WEAPON_TYPES '+String(W).slice(0,200));
 await m.close();})();
