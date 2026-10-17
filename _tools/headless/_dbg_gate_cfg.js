'use strict';
const { Match } = require('./match');
const S = `(() => {
  var t = VantageTree.getTree(); var d = VantageTree.dumpDiagnostics() || {};
  var st = window.__vantageIface || {};
  return { mark: t ? t.__probeMark : null, cfgMax: t&&t.cfg?t.cfg.maxNodes:null, capOn: t&&t.cfg?t.cfg.nodeCapEnabled:null,
    refine: t&&t.cfg?t.cfg.refineBeyondLimits:null, warmCap: t&&t.cfg?t.cfg.warmupMaxNodes:null,
    gwt: t&&t.cfg?t.cfg.growWithoutThreats:null, horizon: t&&t.cfg?t.cfg.horizonSec:null,
    nodeCount: t?t.nodeCount:null, tickOk: st.tickOk||0, skippedFull: st.tickSkippedFull||0,
    statsSkipFull: d.stats?d.stats.agentSkippedFull:null, liveProj: d.liveProjectileCount,
    shapeN: d.shape?d.shape.nodeCount:null, reserve: d.reserveCount, total: d.totalNodeCount };
})()`;
(async () => {
  const m = new Match();
  try {
    await m.open({ humanIds: ['tank_a'], aiCount: 0, vantCount: 1, rng: 'record' });
    await m.eval(`(VantageTree.setWarmupMaxNodes(3000), VantageTree.setMaxNodes(3000), VantageTree.setGrowWithoutThreatsEnabled(true), 1)`);
    await m.pump(8);
    await m.eval(`(VantageTree.getTree().__probeMark = 777, 1)`);
    console.log('A after set3000:', JSON.stringify(await m.eval(S)));
    await m.eval(`(VantageTree.setMaxNodes(100), 1)`);
    console.log('B right after set100:', JSON.stringify(await m.eval(S)));
    for (let i = 0; i < 6; i++) { await m.pump(2); console.log('C+tick' + (i+1), JSON.stringify(await m.eval(S))); }
  } catch (e) { console.log('FATAL', (e && e.stack) || e); }
  finally { await m.close(); }
  process.exit(0);
})();
