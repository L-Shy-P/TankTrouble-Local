const {Match}=require('./match');
(async()=>{const m=new Match();
 await m.open({humanIds:['tank_a'],aiCount:1,vantCount:1});
 await m.clearControl();
 const api=await m.eval(`(function(){var o={};
   try{ o.CS=typeof CollectibleState; o.CSk=Object.keys(CollectibleState).slice(0,12); o.CSm=Object.keys(CollectibleState.methods?{}:{}).slice(0,6);}catch(e){o.e1=String(e.message||e).slice(0,40);}
   try{ var gc=GameManager.getGameController(); var rm=gc.getRoundModel?gc.getRoundModel():null;
     o.rm=!!rm; o.rmM=rm?Object.keys(rm).filter(function(k){return /collectible|weapon/i.test(k)}).slice(0,8):null;
     o.aiIds=gc.getPlayerIds?String(gc.getPlayerIds()):'n/a';}catch(e){o.e2=String(e.message||e).slice(0,40);}
   try{ o.CT=JSON.stringify(Constants.COLLECTIBLE_TYPES).slice(0,260); }catch(e){o.e3=String(e.message||e).slice(0,40);}
   return JSON.stringify(o);})()`);
 console.log('API '+String(api).slice(0,600));
 // 每帧采 AI 的当前武器类型
 await m.eval(`(function(){window.__w={types:{},n:0};return 'ok';})()`);
 for(let i=0;i<300;i++){
   await m.eval(`(function(){try{var gc=GameManager.getGameController();var rm=gc.getRoundModel?gc.getRoundModel():null;
     if(!rm)return 0; var ids=gc.getPlayerIds?gc.getPlayerIds():[]; for(var j=0;j<ids.length;j++){var id=ids[j];
       var wk=rm.getActiveWeapon?rm.getActiveWeapon(id):null; var t=wk&&wk.getType?String(wk.getType()):'none';
       window.__w.types[t]=(window.__w.types[t]||0)+1; window.__w.n++; }}catch(e){}return 1;})()`);
   await m.pump(1,{yieldMs:0});
 }
 const w=JSON.parse(await m.eval('JSON.stringify(window.__w)'));
 console.log('WEAPONS_SEEN '+JSON.stringify(w).slice(0,300));
 await m.close();})();
