const {Match}=require('./match');
(async()=>{const m=new Match();
 await m.open({humanIds:['tank_a'],aiCount:1,vantCount:1});
 await m.clearControl();
 const api=await m.eval(`(function(){var o={};
  try{var gc=GameManager.getGameController();var M=gc.roundController.model;
   o.hasModel=!!M; o.modelKeys=M?Object.keys(M):null;
   o.fnSetCollectible=typeof M.setCollectibleState; o.fnSetCollectibles=typeof M.setCollectibleStates;
   o.fnGetActive=typeof M.getActiveWeapon; o.fnGetTanks=typeof M.getTanks;
   o.tanks=M&&M.getTanks?Object.keys(M.getTanks()):null;
   if(M&&M.getTanks){var ids=Object.keys(M.getTanks()); if(ids.length){var w=M.getActiveWeapon?M.getActiveWeapon(ids[0]):null; o.weapon=w&&w.getType?String(w.getType()):'none';}} 
  }catch(e){o.e1=String(e.message||e).slice(0,60);}
  try{o.CSmethods=Object.keys(CollectibleState.__methods||{}).slice(0,12);}catch(e){o.e2=String(e.message||e).slice(0,40);}
  return JSON.stringify(o);})()`);
 console.log('API '+String(api).slice(0,700));
 await m.close();})();
