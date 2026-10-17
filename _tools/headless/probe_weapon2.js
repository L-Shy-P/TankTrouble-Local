const {Match}=require('./match');
(async()=>{const m=new Match();
 await m.open({humanIds:['tank_a'],aiCount:1,vantCount:1});
 await m.clearControl();
 const inj=await m.eval(`(function(){var out={injected:[]};
  try{var M=GameManager.getGameController().roundController.model; var id=Object.keys(M.tanks||{})[0];
   var types=[0,2,3];  // LASER, SHOTGUN, HOMING_MISSILE
   for(var i=0;i<types.length;i++){ try{ var st=WeaponState.withState(9100+i,id,types[i],'{}'); M.setWeaponState(st); out.injected.push(types[i]); }catch(e){ out.err=String(e.message||e).slice(0,50); } }
   out.other=(M.playerIdOtherWeaponIds[id]||[]).length; out.aiId=id;
  }catch(e){out.e=String(e.message||e).slice(0,60);}
  return JSON.stringify(out);})()`);
 console.log('INJECT2 '+String(inj).slice(0,240));
 await m.eval(`(function(){window.__pw={fired:0,ptypes:{},n:0};try{var gc=GameManager.getGameController();
   gc.addRoundEventListener(function(self,id,evt,data){if(String(evt)==='weapon fired')window.__pw.fired++;},window.__pw);}catch(e){}return 'ok';})()`);
 for(let i=0;i<400;i++){
   await m.eval(`(function(){try{var M=GameManager.getGameController().roundController.model;
     var ps=M.projectiles||{}; var ks=Object.keys(ps);
     for(var j=0;j<ks.length;j++){var p=ps[ks[j]]; var t=(p&&p.getType)?String(p.getType()):'?';
       window.__pw.ptypes[t]=(window.__pw.ptypes[t]||0)+1;} window.__pw.n++;}catch(e){}return 1;})()`);
   await m.pump(1,{yieldMs:0});
 }
 const pw=JSON.parse(await m.eval('JSON.stringify(window.__pw)'));
 console.log('FIRE2 fired='+pw.fired+'  projectileTypesSeen='+JSON.stringify(Object.keys(pw.ptypes))+'  counts='+JSON.stringify(pw.ptypes).slice(0,160));
 await m.close();})();
