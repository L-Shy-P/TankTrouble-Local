const { launch, sleep } = require('./cdp');
const { startPyServer } = require('./pyserver');
(async () => {
  const srv = await startPyServer({});
  const b = await launch({});
  const { targetId, sessionId } = await b.newPage('about:blank');
  const errs = [];
  b.on('Runtime.exceptionThrown', (p) => { const d=p.exceptionDetails||{}; errs.push(String((d.exception&&d.exception.description)||d.text).slice(0,200)); }, sessionId);
  await b.send('Page.enable', {}, sessionId); await b.send('Runtime.enable', {}, sessionId);
  const loaded = b.waitFor('Page.loadEventFired', 90000, sessionId);
  await b.send('Page.navigate', { url: `${srv.origin}/index.html` }, sessionId);
  await loaded; await sleep(20000);
  const r = await b.evaluate(`({ phaser: typeof Phaser, gm: typeof GameManager, tree: typeof VantageTree, poseDebug: !!window.__vtPoseDebug })`, sessionId);
  console.log('加载结果:', JSON.stringify(r));
  console.log('异常:', JSON.stringify(errs.slice(0,4)));
  await b.closePage(targetId); await b.close(); await srv.close();
})().catch(e => { console.error('FAILED', e.message); process.exit(1); });
