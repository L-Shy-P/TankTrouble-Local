const fs=require('fs'),path=require('path');const {Match}=require('./match');
const OUT=path.join(__dirname,'_g8_prof');
const INSTALL=`(()=>{window.__h={
 ad:(pid)=>VantageSandbox.createAdapter(GameManager.getGameController(),pid),
 enc:(pid)=>{const ad=window.__h.ad(pid);return VantageObserve.encode({adapter:ad,tree:null,horizonSec:10,K_death:1,frameDt:0.02});},
 grant:(pid)=>{const gc=GameManager.getGameController();const st=ShieldUpgrade.createInitialUpgradeState(IdGenerator.instance.gen('g8'),pid);gc.roundController.setUpgradeState(st);return st.getId();},
 shieldFields:(pid)=>{const gc=GameManager.getGameController();const u=gc.getUpgradeByPlayerIdAndType(pid,2);if(!u)return null;
   var o={id:(u.getId?u.getId():null),type:(u.getType?u.getType():null)};
   try{o.fields=u.getFields?u.getFields():null;}catch(e){o.fieldsErr=String(e.message||e);}
   try{o.hasOwnField_lifetime=(u.classs&&u.classs().hasOwnField)?u.classs().hasOwnField('_lifetime'):null;}catch(e){}
   try{o.getField_lifetime=u.getField?u.getField('lifetime'):null;}catch(e){o.getFieldErr=String(e.message||e);}
   try{o.getField_life=u.getField?u.getField('life'):null;}catch(e){}
   try{o.getField_timeLeft=u.getField?u.getField('timeLeft'):null;}catch(e){}
   try{o.getField_spawnTime=u.getField?u.getField('spawnTime'):null;}catch(e){}
   return o;},
 tanks:()=>Object.keys(window.__h.ad('tank_a').getTanks())
};return 1;})()`;
(async()=>{const res={steps:[],errors:[]};const m=new Match();
 const add=(n,o)=>{res.steps.push(Object.assign({name:n},o));console.log(n+' '+JSON.stringify(o).slice(0,1400));};
 try{ await m.open({humanIds:['tank_a'],aiCount:2,vantCount:0}); await m.clearControl(); await m.eval(INSTALL); await m.pump(3,{yieldMs:0});
  add('1_tanks',{tanks:await m.eval('JSON.stringify(window.__h.tanks())')});
  const before=await m.eval(`(function(){var e=window.__h.enc('tank_a');return JSON.stringify({oppLen:e.global.oppTok.length,oppIds:e.global.diag.oppIds,alive:e.global.diag.oppAlive,mismatch:e.global.diag.oppLenMismatch,oppTok:e.global.oppTok});})()`);
  add('2_opp_before',{raw:before});
  const gid=await m.eval(`window.__h.grant('tank_a')`); await m.pump(3,{yieldMs:0});
  add('3_shield_real_fields',{upgradeId:gid,raw:await m.eval(`JSON.stringify(window.__h.shieldFields('tank_a'))`)});
  const after=await m.eval(`(function(){var e=window.__h.enc('tank_a');return JSON.stringify({oppLen:e.global.oppTok.length,mismatch:e.global.diag.oppLenMismatch,oppTok:e.global.oppTok,suspect:e.global.oppTok.filter(function(v){return v===null;}).length});})()`);
  add('4_opp_after',{raw:after});
 }catch(e){res.errors.push(String(e&&e.stack||e));}
 finally{try{await m.close();}catch(e){}}
 fs.mkdirSync(OUT,{recursive:true});fs.writeFileSync(path.join(OUT,'_g8_real.json'),JSON.stringify(res,null,1));console.log('ERRORS '+JSON.stringify(res.errors));})();
