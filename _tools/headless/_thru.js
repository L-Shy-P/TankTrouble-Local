const { Match } = require('./match');
(async () => {
  const t0 = Date.now();
  const m = new Match();
  await m.open({ humanIds: ['tank_a'], aiCount: 2, vantCount: 0, rng: 'flat', rngMode: 'flat' });
  const tOpen = Date.now();
  await m.clearControl();
  await m.pump(1200, { yieldMs: 0 });
  const tRec = Date.now();
  const dur = await m.eval(`(function(){ var d = window.__vtRng.dump(); return JSON.stringify({n: (d && d.length) || 0, type: typeof d, sample: (d && d.slice) ? d.slice(0,2) : null}); })()`);
  console.log('T_OPEN_MS ' + (tOpen - t0));
  console.log('T_RECORD_MS ' + (tRec - tOpen));
  console.log('RNG_DUMP ' + dur);
  await m.close();
  console.log('T_TOTAL_MS ' + (Date.now() - t0));
})();
