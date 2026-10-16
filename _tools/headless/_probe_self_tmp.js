const fs=require('fs');const {Match}=require('./match');
const SRC=fs.readFileSync(__dirname+'/inject_fire.js','utf8');
(async()=>{
  const m=new Match(); const op=await m.open({humanIds:[],aiCount:1,vantCount:1,control:false});
  console.log('OPEN ai='+JSON.stringify(op.aiIds)+' vant='+JSON.stringify(op.vantageIds));
  await m.eval(SRC); await m.eval("window.__b.tankId='vantage_1'"); await m.eval('window.__probe.setup()');
  await m.pump(20,{yieldMs:0});
  for(let k=0;k<3;k++){
    const o=JSON.parse(await m.eval('window.__b.step(0,0)'));
    const g=o.g||[];
    const snap=await m.snapshot();
    const tanks=(snap.tanks||[]).map(t=>({id:t.id,x:+t.x.toFixed(2),y:+t.y.toFixed(2)}));
    console.log('OBS self x,y =',(+g[6]).toFixed(2),(+g[7]).toFixed(2),'| oppTok[0..2]=',(o.opp||[]).slice(0,3).map(v=>+v.toFixed(2)).join(','));
    console.log('REAL tanks  =',JSON.stringify(tanks));
    await m.pump(20,{yieldMs:0});
  }
  await m.close();
})().catch(e=>{console.log('FATAL '+((e&&e.stack)||e));process.exit(1)});
