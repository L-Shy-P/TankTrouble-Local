const {Match}=require('./match');
(async()=>{const m=new Match();
 await m.open({humanIds:['tank_a'],aiCount:1,vantCount:1});
 await m.clearControl();
 const k1=await m.eval("JSON.stringify(Object.keys(CollectibleState.__methods||{}))");
 console.log('STEP1_METHODS '+String(k1).slice(0,300));
 const k2=await m.eval("JSON.stringify(Object.keys(CollectibleState.__constructors||{}))");
 console.log('STEP1_CTORS '+String(k2).slice(0,300));
 const k3=await m.eval("JSON.stringify({cc:Object.keys(Constants.COLLECTIBLE_TYPES).slice(0,10),fake:typeof CollectibleState.withState,fi:typeof CollectibleState.withObject,fc:typeof CollectibleState.create})");
 console.log('STEP1_TYPES '+String(k3).slice(0,300));
 // 第2步：造箱 + 摆箱（多种构造法都试，只打结果短串）
 const r2=await m.eval(`(function(){var out={};
   try{var gc=GameManager.getGameController();var M=gc.roundController.model;
     out.hasM=!!M; out.tanks=typeof M.getTanks; out.setC=typeof M.setCollectibleState;
     var ids=Object.keys(M.tanks||{}); out.ids=ids.length; out.aiId=ids[0]||null;
     var t=out.aiId?M.tanks[out.aiId]:null; out.pos=t?[Math.round(t.x),Math.round(t.y)]:null;
     out.made=0; out.err=null;
     if(out.aiId&&t){
       var tries=[['withState',function(){return CollectibleState.withState(9001,out.aiId,Constants.COLLECTIBLE_TYPES.CRATE_LASER,'{}');}],
                  ['withObject',function(){return CollectibleState.withObject({id:9001,type:Constants.COLLECTIBLE_TYPES.CRATE_LASER,x:t.x,y:t.y});}]];
       for(var i=0;i<tries.length;i++){ try{ var st=tries[i][1](); if(st){M.setCollectibleState(st); out.made++; out.by=tries[i][0]; break;} }catch(e){ out.err=String(e.message||e).slice(0,50); } }
     }
   }catch(e){out.e=String(e.message||e).slice(0,60);}
   return JSON.stringify(out);})()`);
 console.log('STEP2_SPAWN '+String(r2).slice(0,400));
 // 第3步：每帧读武器值
 await m.eval("(function(){window.__wp={vals:{},n:0,first:[]};return 'ok';})()");
 for(let i=0;i<200;i++){
   await m.eval(`(function(){try{var M=GameManager.getGameController().roundController.model;
     var ids=Object.keys(M.tanks||{}); for(var j=0;j<ids.length;j++){var id=ids[j];
       var dw=M.playerIdDefaultWeaponId?M.playerIdDefaultWeaponId[id]:undefined;
       var ow=M.playerIdOtherWeaponIds?M.playerIdOtherWeaponIds[id]:undefined;
       var key=String(dw)+'|'+(ow&&ow.length?ow.length:0);
       window.__wp.vals[key]=(window.__wp.vals[key]||0)+1;
       if(window.__wp.first.length<20)window.__wp.first.push(key);
       window.__wp.n++;}}catch(e){}return 1;})()`);
   await m.pump(1,{yieldMs:0});
 }
 const w=JSON.parse(await m.eval('JSON.stringify(window.__wp)'));
 console.log('STEP3_WEAPON keys='+JSON.stringify(Object.keys(w.vals))+'  first20='+JSON.stringify(w.first).slice(0,200)+'  n='+w.n);
 await m.close();})();
