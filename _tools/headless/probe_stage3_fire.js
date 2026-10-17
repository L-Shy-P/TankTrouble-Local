const {Match}=require('./match');
(async()=>{const m=new Match();
 await m.open({humanIds:['tank_a'],aiCount:2,vantCount:1});
 await m.clearControl();
 await m.eval(`(function(){window.__f={fired:0,types:{},proj:0};
   var gc=GameManager.getGameController();
   gc.addRoundEventListener(function(self,id,evt,data){var s=String(evt);
     if(s==='weapon fired'){window.__f.fired++;} },window.__f);
   return 'ok';})()`);
 // 等回合开始
 let started=false;
 for(let i=0;i<20;i++){ const p0=await m.myTank(); if(!p0)break;
   await m.setControl({fwd:true}); await m.pump(8,{yieldMs:4}); const p1=await m.myTank();
   if(p1&&Math.hypot(p1.x-p0.x,p1.y-p0.y)>0.5){started=true;break;} }
 await m.clearControl();
 // 边跑边读弹体类型
 for(let i=0;i<600;i++){
   if(i%20===0) await m.eval(`(function(){try{var rm=GameManager.getGameController().getRoundModel?GameManager.getGameController().getRoundModel():null;
     if(!rm||!rm.getProjectiles)return 0; var ps=rm.getProjectiles(); var ks=Object.keys(ps);
     for(var j=0;j<ks.length;j++){var p=ps[ks[j]]; var t=(p&&p.getType)?String(p.getType()):'?';
       window.__f.types[t]=(window.__f.types[t]||0)+1; window.__f.proj++;} }catch(e){}
     return 1;})()`);
   await m.setControl(i%4<2?{fwd:true,left:true}:{fwd:true,right:true});
   await m.pump(1,{yieldMs:0});
 }
 await m.clearControl();
 const f=JSON.parse(await m.eval('JSON.stringify(window.__f)'));
 const W=JSON.parse(await m.eval("JSON.stringify((function(){try{return Constants.WEAPON_TYPES}catch(e){return null}})())"));
 console.log('FIRE fired='+f.fired+' projSeen='+f.proj+' types='+JSON.stringify(f.types));
 console.log('WEAPON_TYPES '+JSON.stringify(W).slice(0,220));
 console.log('STARTED '+started);
 await m.close();})();
