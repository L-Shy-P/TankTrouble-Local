const {Match}=require('./match');
const FR=Number(process.env.FRAMES||1200);
(async()=>{const m=new Match();
 await m.open({humanIds:['tank_a'],aiCount:2,vantCount:1,rng:'record',rngMode:'record'});
 await m.clearControl();
 const keys=await m.eval(`(function(){var o={};try{o.treeKeys=Object.keys(window.VantageTree).filter(function(k){return /iface|stat|diag|agent|debug/i.test(k);});
   o.ifaceKeys=window.VantageTreeInterface?Object.keys(window.VantageTreeInterface).slice(0,30):null;
   try{o.aName=(VantageTreeInterface.Agents&&VantageTreeInterface.Agents.current)?String(VantageTreeInterface.Agents.current('A')&&VantageTreeInterface.Agents.current('A').name||''):'no-api';}catch(e){o.aName='err';}
   try{o.bName=(VantageTreeInterface.Agents&&VantageTreeInterface.Agents.current)?String(VantageTreeInterface.Agents.current('B')&&VantageTreeInterface.Agents.current('B').name||''):'';}catch(e){}
   o.gKeys=Object.keys(window).filter(function(k){return /iface|Iface/i.test(k);}).slice(0,10);
  }catch(e){o.err=String(e.message||e).slice(0,60);}return JSON.stringify(o);})()`);
 console.log('IFACE_KEYS '+keys.slice(0,600));
 let decCalled=0,skippedRules=0,skippedNotReady=0,other=0,retriesTot=0,agentSkippedFullLast=0;
 for(let i=0;i<FR;i++){ await m.pump(1,{yieldMs:0});
  if(i%50===49||i===FR-1){ const s=JSON.parse(await m.eval(`(function(){var o={};try{
    var st=(VantageTree.getTree&&VantageTree.getTree()||{}).stats||{};o.asf=st.agentSkippedFull||0;
    for(var k in st){if(/retry|retries|skip/i.test(k))o['s_'+k]=st[k];}
    var g=window.__vtIfaceStats||null; if(g){o.skipped=g.skipped||null;o.retries=g.retries||0;o.decWrites=g.decWrites||0;}
    }catch(e){o.err=String(e.message||e).slice(0,40);}return JSON.stringify(o);})()`));
   if(s.asf!==undefined)agentSkippedFullLast=s.asf;
   if(s.skipped==='规则模式')skippedRules++; else if(s.skipped==='智能体未就绪')skippedNotReady++; else if(s.skipped)other++; else decCalled++;
   if(s.retries)retriesTot+=s.retries;
  }
 }
 console.log('IFACE_RESULT frames=%d decCalled(skipped-empty samples)=%d skippedRules=%d skippedNotReady=%d other=%d retriesSum=%d agentSkippedFullLast=%d',
  FR,decCalled,skippedRules,skippedNotReady,other,retriesTot,agentSkippedFullLast);
 console.log('IFACE_NOTE 若 __vtIfaceStats 不存在(skipped 永远 null) ⟹ decCalled 计数=采样数(不可信), 需先暴露 _ifaceStats');
 await m.close();})();
