const { Match } = require('./match');
const N = Number(process.env.ROUNDS || 10);
(async () => {
  const t0 = Date.now(); const m = new Match();
  let _ok=false; for (let _try=0;_try<3 && !_ok;_try++) { try { await m.open({ humanIds: ['tank_a'], aiCount: 1, vantCount: 0 }); _ok=true; } catch (e) { if (_try===2) throw e; } }
  const t1 = Date.now(); const times = [];
  for (let i = 0; i < N; i++) { const a = Date.now(); await m.pump(600, { yieldMs: 0 }); times.push(Date.now() - a); }
  const t2 = Date.now(); await m.close();
  const rest = times.slice(1); const amort = rest.reduce((x, y) => x + y, 0) / Math.max(1, rest.length);
  console.log('REUSE pid=' + process.pid + ' open=' + (t1 - t0) + ' first=' + times[0] + ' amort=' + amort.toFixed(0) + ' total=' + (t2 - t0) + ' N=' + N);
})();
