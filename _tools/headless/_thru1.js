const { Match } = require('./match');
(async () => { const t0 = Date.now(); const m = new Match();
  await m.open({ humanIds: ['tank_a'], aiCount: 1, vantCount: 0 });
  const t1 = Date.now(); await m.pump(600, { yieldMs: 0 }); const t2 = Date.now();
  await m.close(); console.log('ONE open=' + (t1-t0) + ' pump600=' + (t2-t1) + ' total=' + (Date.now()-t0)); })();
