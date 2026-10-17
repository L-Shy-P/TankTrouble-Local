const fs=require('fs'),path=require('path');const {Match}=require('./match');
const OUT=path.join(__dirname,'_g11_prof');
const INSTALL=`(()=>{window.__M={
 gc:()=>GameManager.getGameController(),
 ad:(pid)=>VantageSandbox.createAdapter(GameManager.getGameController(),pid),
 tanks:()=>Object.keys(window.__M.ad('tank_a').getTanks()),
 grantRaw:(id,playerId)=>{const gc=GameManager.getGameController();
   const st=ShieldUpgrade.createInitialUpgradeState(IdGenerator.instance.gen('su'), playerId, Constants.SHIELD_LIFETIME);
   gc.roundController.setUpgradeState(st);
   return {grantedWith:String(playerId), argType:(typeof playerId)===('number')?'number':'string'};},
 enc:(pid)=>{const e=VantageObserve.encode({adapter:window.__M.ad(pid),tree:null,horizonSec:10,K_death:1,frameDt:1/60});return {oppTok:e.global.oppTok,rows:e.global.diag.oppIds};},
 shieldRaw:(pid)=>{const gc=GameManager.getGameController();const u=gc.getUpgradeByPlayerIdAndType(pid,2);if(!u)return {found:false};return {found:true,lifetime:(typeof u.getField==='function')?u.getField('lifetime'):null};}
};return 1;})()`;
(async()=>{const res={};const m=new Match();
 const add=(n,o)=>{res[n]=o;console.log(n+' '+JSON.stringify(o).slice(0,600));};
 try{ await m.open({humanIds:['tank_a'],aiCount:1,vantCount:0}); await m.clearControl(); await m.eval(INSTALL); await m.pump(2,{yieldMs:0});
  const keys=JSON.parse(await m.eval('JSON.stringify(window.__M.tanks())'));
  const oppKey=keys.filter(k=>k!=='tank_a')[0]; res.oppKey=oppKey;
  add('0_before',{oppRow:JSON.parse(await m.eval('JSON.stringify(window.__M.enc("tank_a").oppTok.slice(0,15))'))});
  // ① 用【数字 id】建档（= 真拾取的行为）
  add('1_grantNumeric',JSON.parse(await m.eval(`JSON.stringify(window.__M.grantRaw('su', Number(${JSON.stringify(oppKey)})))`)));
  await m.pump(3,{yieldMs:0});
  add('1_after_numeric',{rawForNumber:JSON.parse(await m.eval(`JSON.stringify(window.__M.shieldRaw(Number(${JSON.stringify(oppKey)})))`)),
    rawForString:JSON.parse(await m.eval(`JSON.stringify(window.__M.shieldRaw(${JSON.stringify(oppKey)}))`)),
    oppRow:JSON.parse(await m.eval('JSON.stringify(window.__M.enc("tank_a").oppTok.slice(0,15))'))});
  // ② 清掉再【字符串 id】建档（= 复验 _g8 假绿那条）
  await m.eval(`(function(){var gc=window.__M.gc();var u=gc.getUpgradeByPlayerIdAndType(Number(${JSON.stringify(oppKey)}),2);
     if(u&&u.getId){try{gc.roundController.removeUpgrade(u.getId());}catch(e){}}}())`);
  await m.pump(2,{yieldMs:0});
  add('2_afterRemove',{oppRow:JSON.parse(await m.eval('JSON.stringify(window.__M.enc("tank_a").oppTok.slice(0,15))'))});
  add('2_grantString',JSON.parse(await m.eval(`JSON.stringify(window.__M.grantRaw('su', ${JSON.stringify(oppKey)}))`)));
  await m.pump(3,{yieldMs:0});
  add('2_after_string',{raw:JSON.parse(await m.eval(`JSON.stringify(window.__M.shieldRaw(${JSON.stringify(oppKey)}))`)),
    oppRow:JSON.parse(await m.eval('JSON.stringify(window.__M.enc("tank_a").oppTok.slice(0,15))'))});
 }catch(e){res.errors=[String(e&&e.stack||e)];}
 finally{try{await m.close();}catch(e){}}
 fs.mkdirSync(OUT,{recursive:true});fs.writeFileSync(path.join(OUT,'_g11.json'),JSON.stringify(res,null,1));
 console.log('ERR '+JSON.stringify(res.errors||[]));})();
