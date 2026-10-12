const { launch, sleep } = require('./cdp');
const { startPyServer } = require('./pyserver');
const fs = require('fs'), path = require('path');
(async () => {
  const srv = await startPyServer({});
  const b = await launch({});
  const { targetId, sessionId } = await b.newPage('about:blank');
  const errs = [], logs = [];
  b.on('Runtime.exceptionThrown', (p) => { const d = p.exceptionDetails||{}; errs.push(String((d.exception&&d.exception.description)||d.text).slice(0,300)); }, sessionId);
  b.on('Runtime.consoleAPICalled', (p) => { const t=(p.args||[]).map(a=>a.value!==undefined?a.value:(a.description||a.type)).join(' '); logs.push(t.slice(0,200)); }, sessionId);
  await b.send('Page.enable', {}, sessionId);
  await b.send('Runtime.enable', {}, sessionId);
  const loaded = b.waitFor('Page.loadEventFired', 90000, sessionId);
  await b.send('Page.navigate', { url: `${srv.origin}/vantage_pose_debug.html` }, sessionId);
  await loaded;
  await sleep(45000);
  const r = await b.evaluate(`(() => {
    var out = { hasGM: typeof GameManager, hasCanvas: !!document.getElementById('vpdCanvas'),
                panel: (document.getElementById('vpdInfo')||{}).textContent };
    try { var g = GameManager.getGame(); out.state = g ? g.state.current : 'no game'; } catch(e){ out.state='ERR'; }
    try { out.hasGC = !!GameManager.getGameController(); } catch(e){}
    try { var t = GameManager.getGameController().getTank('tank_a'); out.tank = t ? [Math.round(t.getX()), Math.round(t.getY())] : null; } catch(e){}
    return out;
  })()`, sessionId, { awaitPromise: true });
  console.log('页面状态:', JSON.stringify(r));
  console.log('异常:', JSON.stringify(errs.slice(0,5)));
  console.log('日志尾:', JSON.stringify(logs.slice(-5)));
  await b.closePage(targetId); await b.close(); await srv.close();
})().catch(e => { console.error('FAILED', e.message); process.exit(1); });
