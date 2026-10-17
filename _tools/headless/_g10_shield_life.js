const fs=require('fs'),path=require('path');const {Match}=require('./match');
const OUT=path.join(__dirname,'_g10_prof');
const INSTALL=`(()=>{window.__K={
 gc:()=>GameManager.getGameController(),
 ad:(pid)=>VantageSandbox.createAdapter(GameManager.getGameController(),pid),
 // ★ 真发盾：ShieldUpgrade.createInitialUpgradeState(id, playerId, lifetime)（游戏 roundcontroller:548 同款，传 Constants.SHIELD_LIFETIME=6.0）
 grantReal:(pid)=>{const gc=GameManager.getGameController();
   const st=ShieldUpgrade.createInitialUpgradeState(IdGenerator.instance.gen('su'), pid, Constants.SHIELD_LIFETIME);
   gc.roundController.setUpgradeState(st);
   return {id:(st.getId?st.getId():null),type:(st.getType?st.getType():null),constLifetime:Constants.SHIELD_LIFETIME};},
 life:(pid)=>{const gc=GameManager.getGameController();const u=gc.getUpgradeByPlayerIdAndType(pid,2);
   if(!u)return {gone:true};
   var o={present:true};
   try{o.getField_lifetime=(typeof u.getField==='function')?u.getField('lifetime'):null;}catch(e){}
   try{o.getField_weakened=(typeof u.getField==='function')?u.getField('weakened'):null;}catch(e){}
   try{o.rawFields=u.getFields?u.getFields():null;}catch(e){}
   return o;},
 encSelf:(pid)=>{const ad=window.__K.ad(pid);const e=VantageObserve.encode({adapter:ad,tree:null,horizonSec:10,K_death:1,frameDt:1/60});
   var g=e.global;return {selfShieldLife:g.globalTok[17],selfShieldOn:g.globalTok[16],oppTok:g.oppTok};},
 setDt:(v)=>{try{VantageSandbox.setFrameDtSec(v);return VantageSandbox.getFrameDtSec();}catch(e){return null;}},
 tanks:()=>Object.keys(window.__K.ad('tank_a').getTanks())
};return 1;})()`;
(async()=>{const res={samples:[],cases:{}};const m=new Match();
 try{ await m.open({humanIds:['tank_a'],aiCount:1,vantCount:0}); await m.clearControl(); await m.eval(INSTALL);
  res.dtApplied=await m.eval('window.__K.setDt(1/60)');
  res.tanks=await m.eval('JSON.stringify(window.__K.tanks())');
  // 情形1：无盾（自车）
  res.cases.noShield=JSON.parse(await m.eval(`JSON.stringify({raw:window.__K.life('tank_a'),tok:window.__K.encSelf('tank_a').selfShieldLife,on:window.__K.encSelf('tank_a').selfShieldOn})`));
  // 真发盾
  res.grant=JSON.parse(await m.eval(`JSON.stringify(window.__K.grantReal('tank_a'))`));
  for(let f=0;f<=420;f+=30){
    const s=JSON.parse(await m.eval(`JSON.stringify({f:${f},raw:window.__K.life('tank_a'),tok:window.__K.encSelf('tank_a').selfShieldLife})`));
    res.samples.push(s);
    if(f<420) await m.pump(30,{yieldMs:0});
  }
  // 对手侧：给对手真发盾
  const opp=JSON.parse(await m.eval('JSON.stringify(Object.keys(window.__K.ad("tank_a").getTanks()).filter(function(k){return k!=="tank_a";})[0])'));
  res.grantOpp=JSON.parse(await m.eval(`JSON.stringify(window.__K.grantReal(${opp}))`)); await m.pump(5,{yieldMs:0});
  res.cases.oppShield=JSON.parse(await m.eval(`JSON.stringify({opp:${opp},raw:window.__K.life(${opp}),oppTok:window.__K.encSelf('tank_a').oppTok.slice(0,15)})`));
 }catch(e){res.errors=[String(e&&e.stack||e)];}
 finally{try{await m.close();}catch(e){}}
 fs.mkdirSync(OUT,{recursive:true});fs.writeFileSync(path.join(OUT,'_g10.json'),JSON.stringify(res,null,1));
 console.log('dt='+res.dtApplied+' grant='+JSON.stringify(res.grant));
 console.log('无盾:'+JSON.stringify(res.cases.noShield));
 console.log('曲线:'+res.samples.map(s=>s.f+':'+JSON.stringify(s.raw.getField_lifetime===undefined?(s.raw.gone?'gone':'?'):s.raw.getField_lifetime)+'/tok'+s.tok).join(' | '));
 console.log('对手:'+JSON.stringify(res.cases.oppShield));
 console.log('ERR '+JSON.stringify(res.errors||[]));})();
