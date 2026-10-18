const { Match } = require('../headless/match');
(async()=>{
 const m=new Match();
 await m.open({players:2,control:false});
 await m.pump(60);
 const STEP = `(() => { var a = new Event('x').timeStamp; window.__vtStep(1); return new Event('x').timeStamp - a; })()`;
 const med=a=>{const b=a.slice().sort((x,y)=>x-y);return b[b.length>>1]};
 let on=[], off=[], pr=[];
 for (let i=0;i<40;i++) off.push(await m.eval(STEP));
 await m.eval('GameManager.getGame().paused = true; 1');
 for (let i=0;i<40;i++) on.push(await m.eval(STEP));
 await m.eval('GameManager.getGame().paused = false; 1');
 // 每帧 暂停→立刻恢复（模拟同步闸门）
 for (let i=0;i<40;i++) {
   const t = await m.eval(`(() => { var g=GameManager.getGame(); var a=new Event('x').timeStamp; g.paused=true; window.__vtStep(1); g.paused=false; g._deltaTime=0; g.updatesThisFrame=0; return new Event('x').timeStamp - a; })()`);
   pr.push(t);
 }
 console.log(JSON.stringify({ normalMed:+med(off).toFixed(2), pausedMed:+med(on).toFixed(2), pauseResumeMed:+med(pr).toFixed(2),
   normalP90:+off.slice().sort((a,b)=>a-b)[36].toFixed(2), pausedP90:+on.slice().sort((a,b)=>a-b)[36].toFixed(2) }));
 await m.close();
})().catch(e=>{console.error(e);process.exit(1)});
