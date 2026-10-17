const fs=require('fs');const {Match}=require('./match');
const SRC=fs.readFileSync(__dirname+'/inject_sink.js','utf8');
(async()=>{const m=new Match();
 await m.open({humanIds:['tank_a'],aiCount:2,vantCount:1});
 await m.clearControl(); await m.eval(SRC); await m.eval('window.__probe.setup()');
 for(let i=0;i<3600;i++){ await m.eval('window.__probe.step('+i+')'); await m.pump(1,{yieldMs:0}); }
 const samples=JSON.parse(await m.eval('JSON.stringify(window.__probe.samples)'));
 const roundFrames=JSON.parse(await m.eval('JSON.stringify(window.__probe.roundStartFrames)'));
 const memAfter=JSON.parse(await m.eval('JSON.stringify(window.__probe.memLog.filter(function(e){return e.f>=3330;}))'));
 const seg=await m.eval('String(window.__probe.seg)');
 const out='D:/vt_run/datasets/a_samples_sink.jsonl';
 fs.writeFileSync(out, samples.map(s=>JSON.stringify(s)).join('\n')+'\n');
 const bytes=fs.statSync(out).size;
 console.log('SINK segChanges='+seg+' aSamples='+samples.length+' bytes='+bytes+' file='+out);
 console.log('ROUND_STARTS '+JSON.stringify(roundFrames));
 console.log('MEM_AFTER_START '+JSON.stringify(memAfter).slice(0,400));
 await m.close();})();
