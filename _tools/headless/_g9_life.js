const fs=require('fs'),path=require('path');const {Match}=require('./match');
const OUT=path.join(__dirname,'_g9_prof');
const INSTALL=`(()=>{window.__L={
 grant:(pid)=>{const gc=GameManager.getGameController();const st=ShieldUpgrade.createInitialUpgradeState(IdGenerator.instance.gen('g9'),pid);gc.roundController.setUpgradeState(st);return st.getId();},
 life:(pid)=>{const gc=GameManager.getGameController();const u=gc.getUpgradeByPlayerIdAndType(pid,2);if(!u)return {gone:true};
   var o={};try{o.rawFields=u.getFields?u.getFields():null;}catch(e){o.err=String(e.message||e);}
   try{o.getField_lifetime=(typeof u.getField==='function')?u.getField('lifetime'):null;}catch(e){}
   try{o.getField_weakened=(typeof u.getField==='function')?u.getField('weakened'):null;}catch(e){}
   try{o.hasBody=!!u.getB2DBody;}catch(e){}
   return o;}
};return 1;})()`;
(async()=>{const res={samples:[],errors:[]};const m=new Match();
 try{ await m.open({humanIds:['tank_a'],aiCount:1,vantCount:0}); await m.clearControl(); await m.eval(INSTALL); await m.pump(2,{yieldMs:0});
  res.upgradeId=await m.eval(`window.__L.grant('tank_a')`);
  for(let f=0;f<=150;f+=10){
    const s=await m.eval(`JSON.stringify({f:${f},v:window.__L.life('tank_a')})`);
    res.samples.push(JSON.parse(s));
    if(f<150) await m.pump(10,{yieldMs:0});
  }
 }catch(e){res.errors.push(String(e&&e.stack||e));}
 finally{try{await m.close();}catch(e){}}
 fs.mkdirSync(OUT,{recursive:true});fs.writeFileSync(path.join(OUT,'_g9_life.json'),JSON.stringify(res,null,1));
 const key=res.samples.map(s=>s.f+':'+JSON.stringify(s.v.getField_lifetime===undefined?(s.v.gone?'gone':'?'):s.v.getField_lifetime));
 console.log('lifetime曲线 '+key.join(' | '));
 console.log('ERR '+JSON.stringify(res.errors));})();
