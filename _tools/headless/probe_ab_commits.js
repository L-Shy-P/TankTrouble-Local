const {Match}=require('./match');
const FR=Number(process.env.FRAMES||1200), TAG=process.env.TAG||'ab';
(async()=>{const m=new Match();
 await m.open({humanIds:['tank_a'],aiCount:2,vantCount:1,rng:'record',rngMode:'record'});
 await m.clearControl();
 const t0=Date.now(); let last=null;
 for(let i=0;i<FR;i++){ await m.pump(1,{yieldMs:0});
  if(i%100===99||i===FR-1){ const s=await m.eval(`(function(){var o={f:${i+1}};try{var t=VantageTree.getTree&&VantageTree.getTree();if(!t){o.e=1;return JSON.stringify(o);}
    var st=t.stats||{};o.commits=st.commits;o.expands=st.expands;o.growStepCalls=st.growStepCalls;o.growSkips=st.growSkips;
    for(var k in st){if(/agent/i.test(k))o['st_'+k]=st[k];}
    var d=JSON.stringify(VantageTree.dumpDiagnostics(t));var mm=d.match(/agent-silent-no-grow/g);o.silent=mm?mm.length:0;
    }catch(e){o.err=String(e.message||e).slice(0,50);}return JSON.stringify(o);})()`); last=s; }
 }
 const s0=last?JSON.parse(last):{};
 const d0=await m.eval(`(function(){var o={};try{var t=VantageTree.getTree();var st=t.stats||{};o.ver=VantageTree.VERSION;
   for(var k in st){if(/commit|expand|grow|agent/i.test(k))o[k]=st[k];}}catch(e){o.err=1;}return JSON.stringify(o);})()`);
 console.log('AB '+TAG+' '+JSON.stringify({frames:FR,ms:Date.now()-t0,stats:JSON.parse(d0),silent:JSON.parse(last||'{}').silent}));
 await m.close();})();
