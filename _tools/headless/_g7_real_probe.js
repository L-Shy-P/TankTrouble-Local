const fs=require('fs'),path=require('path');const {Match}=require('./match');
const OUT=path.join(__dirname,'_g7_prof');
const INSTALL=`(()=>{window.__g={
 ad:(pid)=>VantageSandbox.createAdapter(GameManager.getGameController(),pid),
 ws:(pid)=>window.__g.ad(pid).getWeaponStates?window.__g.ad(pid).getWeaponStates(pid):null,
 enc:(pid)=>{const gc=GameManager.getGameController();const ad=window.__g.ad(pid);
   return VantageObserve.encode({adapter:ad,tree:window.VantageTree||null,horizonSec:10,K_death:1,frameDt:0.02});},
 consts:()=>({SHOTGUN_RELOAD_TIME:Constants.SHOTGUN_RELOAD_TIME,GATLING_GUN_FIRE_RATE:Constants.GATLING_GUN_FIRE_RATE,
   BULLET:Constants.WEAPON_TYPES.BULLET,MAX_WEAPON_QUEUE:Constants.MAX_WEAPON_QUEUE,MAX_CRATES:Constants.MAX_CRATES}),
 tanks:()=>Object.keys(window.__g.ad('tank_a').getTanks()),
 grant:(pid)=>{const gc=GameManager.getGameController();const st=ShieldUpgrade.createInitialUpgradeState(IdGenerator.instance.gen('g7'),pid);
   gc.roundController.setUpgradeState(st);return st.getId();},
 shield:(pid,type)=>{const gc=GameManager.getGameController();const u=gc.getUpgradeByPlayerIdAndType(pid,type);if(!u)return null;
   return {lifetime:(typeof u.getField==='function')?u.getField('lifetime'):null,weakened:(typeof u.getField==='function')?u.getField('weakened'):null};}
};return 1;})()`;
(async()=>{const res={steps:[],errors:[]};const m=new Match();
 const add=(n,o)=>{res.steps.push(Object.assign({name:n},o));console.log(n+' '+JSON.stringify(o).slice(0,1100));};
 try{
  await m.open({humanIds:['tank_a'],aiCount:2,vantCount:0});
  await m.clearControl(); await m.eval(INSTALL); await m.pump(3,{yieldMs:0});
  // A：真武器实例 —— 真局打印 getWeaponStates().active.fields 的真键名/真值
  const ws=await m.eval('JSON.stringify(window.__g.ws("tank_a"))');
  add('A_real_weapon_fields',{raw:ws,consts:await m.eval('JSON.stringify(window.__g.consts())')});
  const e1=await m.eval('JSON.stringify(window.__g.enc("tank_a").global.globalTok.slice(28,38))');
  add('A_token_tail10',{tail:e1});
  // B：对手行 15 维（真数字）+ 给一个对手发盾 ⟹ oShieldLife/oShieldWeak
  const e2=await m.eval('JSON.stringify(window.__g.enc("tank_a").global.oppTok.slice(0,15))');
  add('B_opp_row15_beforeShield',{row:e2,tanks:await m.eval('JSON.stringify(window.__g.tanks())')});
  const oppId=await m.eval('JSON.stringify(Object.keys(window.__g.ad("tank_a").getTanks()).filter(function(k){return k!=="tank_a";})[0])');
  const gid=await m.eval('window.__g.grant('+oppId+')'); await m.pump(3,{yieldMs:0});
  add('B_opp_shield',{opp:oppId,upgradeId:gid,raw:await m.eval('JSON.stringify(window.__g.shield('+oppId+',2))'),
    row:await m.eval('JSON.stringify(window.__g.enc("tank_a").global.oppTok.slice(0,15))')});
  // C：真对局纯读 —— Math.random 计数（只在 encode 内计数）
  const c=await m.eval(`(function(){var n=0,orig=Math.random,inf=false;
     Math.random=function(){if(inf){n++;} return orig.apply(Math,arguments);};
     var outer=0; for(var i=0;i<100;i++){inf=true; window.__g.enc('tank_a'); inf=false;}
     Math.random=orig; return JSON.stringify({rngCallsInsideEncode:n});})()`);
  add('C_rng_purity_realgame',{raw:c});
  // D：假阳率 —— 新维 vs 独立直读
  const d=await m.eval(`(function(){var ad=window.__g.ad('tank_a');var ws=ad.getWeaponStates('tank_a');
     var e=window.__g.enc('tank_a');var tok=e.global.globalTok;var i0=tok.length-10;
     var rawCool=(ws.active&&ws.active.fields)?(ws.active.fields._timeSinceFire):undefined;
     var rawAmmo=(ws.active&&ws.active.fields&&typeof ws.active.fields._numBullets==='number')?ws.active.fields._numBullets:null;
     return JSON.stringify({tok_len:tok.length,baseDim:e.global.baseDim,
       tok_wpnCool:tok[i0+5],raw_timeSinceFire:rawCool,
       tok_queue0Type:tok[i0+1],raw_q0type:(ws.queued&&ws.queued[0])?ws.queued[0].type:null,
       tok_queueLen:tok[i0+7],raw_queueLen:ws.queued?ws.queued.length:null,
       tok_wpnDefaultType:tok[i0],raw_defaultType:ws.default?ws.default.type:null,
       suspicious_empty:tok.slice(i0,i0+10)});})()`);
  add('D_fp_crosscheck',{raw:d});
 }catch(e){res.errors.push(String(e&&e.stack||e));}
 finally{try{await m.close();}catch(e){}}
 fs.mkdirSync(OUT,{recursive:true});fs.writeFileSync(path.join(OUT,'_g7_real.json'),JSON.stringify(res,null,1));
 console.log('ERRORS '+JSON.stringify(res.errors));})();
