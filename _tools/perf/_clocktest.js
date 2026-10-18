const fs=require('fs');
const { Match } = require('../headless/match');
(async()=>{
 const m=new Match();
 await m.open({players:2,control:false});
 const r = await m.eval(`(() => {
   function work(){ var t=0; for (var i=0;i<2e6;i++){ t+=Math.sqrt(i); } window.__tk=t; }
   var out = {};
   // ① performance.mark/measure
   try { performance.mark('a'); work(); performance.mark('b'); performance.measure('m','a','b');
         out.mark_ms = performance.getEntriesByName('m')[0].duration; } catch(e) { out.mark_err = String(e); }
   // ② event.timeStamp
   try { var e1=new Event('x'), e2=new Event('x'); work(); var e3=new Event('x'); out.evt_ms = e3.timeStamp - e2.timeStamp; } catch(e){ out.evt_err=String(e); }
   // ③ 真实 Date 逃逸：从 iframe 里拿未被替换的 Date
   try { var ifr=document.createElement('iframe'); ifr.style.display='none'; document.body.appendChild(ifr);
         var RD = ifr.contentWindow.Date; var t0=RD.now(); work(); var t1=RD.now(); out.iframeDate_ms = t1-t0;
         var ip = ifr.contentWindow.performance; var p0=ip.now(); work(); var p1=ip.now(); out.iframePerf_ms = p1-p0; ifr.remove(); } catch(e){ out.ifr_err=String(e); }
   // ④ console.time
   return JSON.stringify(out);
 })()`);
 console.log(r);
 await m.close();
})().catch(e=>{console.error(e);process.exit(1)});
