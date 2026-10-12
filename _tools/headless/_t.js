const { launch, sleep } = require('./cdp');
const { startPyServer } = require('./pyserver');
(async () => {
  const srv = await startPyServer({});
  const b = await launch({});
  const { targetId, sessionId } = await b.newPage('about:blank');
  const errs=[];
  b.on('Runtime.exceptionThrown', p=>{const d=p.exceptionDetails||{};errs.push(String((d.exception&&d.exception.description)||d.text).slice(0,200));},sessionId);
  await b.send('Page.enable',{},sessionId); await b.send('Runtime.enable',{},sessionId);
  const L=b.waitFor('Page.loadEventFired',90000,sessionId);
  await b.send('Page.navigate',{url:`${srv.origin}/index.html`},sessionId);
  await L; await sleep(6000);
  // 打开 T 面板
  await b.evaluate(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'t',code:'KeyT',keyCode:84,which:84,bubbles:true})); 1`,sessionId);
  await sleep(3000);
  const r = await b.evaluate(`(() => {
    var out = { mod: !!window.__vtPoseDebug };
    var sel = document.querySelector('[data-act="aiop-select"]');
    out.hasSel = !!sel;
    out.hasNN = !!(sel && sel.querySelector('option[value="-3"]'));
    out.hasChk = !!document.querySelector('[data-act="exp-poseTarget"]');
    out.panelOpen = !!(sel && sel.offsetParent !== null);
    out.opts = sel ? [].map.call(sel.options, function(o){return o.value;}) : null;
    return out; })()`, sessionId, {awaitPromise:true});
  console.log('检查:', JSON.stringify(r));
  console.log('异常:', JSON.stringify(errs.slice(0,3)));
  await b.closePage(targetId); await b.close(); await srv.close();
})().catch(e=>{console.error('FAILED',e.message);process.exit(1);});
