const {Match}=require('./match');
(async()=>{const m=new Match();
 await m.open({humanIds:['tank_a'],aiCount:1,vantCount:1});
 await m.clearControl();
 const api=await m.eval(`(function(){var o={};
   try{var M=GameManager.getGameController().roundController.model;
     o.setWS=typeof M.setWeaponState; o.getWS=typeof M.getWeaponStates; o.ids=Object.keys(M.tanks||{}).length;
     o.aiId=Object.keys(M.tanks||{})[0]||null; o.before=String(M.playerIdDefaultWeaponId&&o.aiId?M.playerIdDefaultWeaponId[o.aiId]:'n/a');
   }catch(e){o.e=String(e.message||e).slice(0,50);}
   try{o.WSmethods=Object.keys(WeaponState.__methods||{}).slice(0,10);}catch(e){o.e2='WS?';}
   try{o.WSctors=Object.keys(WeaponState.__constructors||{}).slice(0,10);}catch(e){o.e3='WSctor?';}
   try{o.fake=typeof WeaponState.withState; o.finit=typeof WeaponState.withInitialState;}catch(e){}
   return JSON.stringify(o);})()`);
 console.log('API '+String(api).slice(0,500));
 const inj=await m.eval(`(function(){var out={};
   try{var M=GameManager.getGameController().roundController.model; var id=Object.keys(M.tanks||{})[0];
     var tries=[['withState_4',function(){return WeaponState.withState(9001,id,0,'{}');}],
                ['withInitial',function(){return WeaponState.withInitialState?WeaponState.withInitialState(9001,id,0,'{}'):null;}],
                ['withState_5',function(){return WeaponState.withState(9001,id,2,'{}');}]];
     for(var i=0;i<tries.length;i++){ try{ var st=tries[i][1](); if(st){ M.setWeaponState(st); out.ok=tries[i][0]; break; } }catch(e){ out.err=String(e.message||e).slice(0,60); } }
     out.after=String(M.playerIdDefaultWeaponId[id]); out.other=(M.playerIdOtherWeaponIds[id]||[]).length;
   }catch(e){out.e=String(e.message||e).slice(0,60);}
   return JSON.stringify(out);})()`);
 console.log('INJECT '+String(inj).slice(0,300));
 // 每帧读前 20 帧的武器状态
 await m.eval("(function(){window.__w2={first:[]};return 'ok';})()");
 for(let i=0;i<60;i++){
   await m.eval(`(function(){try{var M=GameManager.getGameController().roundController.model;
     var id=Object.keys(M.tanks||{})[0];
     if(window.__w2.first.length<20)window.__w2.first.push(String(M.playerIdDefaultWeaponId[id])+'|'+(M.playerIdOtherWeaponIds[id]||[]).length);}catch(e){}return 1;})()`);
   await m.pump(1,{yieldMs:0});
 }
 const w2=JSON.parse(await m.eval('JSON.stringify(window.__w2)'));
 console.log('READ first20='+JSON.stringify(w2.first).slice(0,300));
 await m.close();})();
