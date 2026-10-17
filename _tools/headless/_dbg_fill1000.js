'use strict';
const { Match } = require('./match');
const S = `(() => { var d=VantageTree.dumpDiagnostics()||{}; var st=window.__vantageIface||{}; var t=VantageTree.getTree();
  return {n:d.shape?d.shape.nodeCount:null, ok:st.tickOk||0, sk:st.tickSkippedFull||0, cfgMax:t&&t.cfg?t.cfg.maxNodes:null, layers:t&&t.cfg?t.cfg.growLayersPerTick:null}; })()`;
(async () => {
  const m = new Match();
  try {
    await m.open({ humanIds: ['tank_a'], aiCount: 0, vantCount: 1, rng: 'record' });
    await m.pump(3);
    console.log('live:', JSON.stringify(await m.eval(S)));
    await m.eval(`(VantageTree.setGrowLayersPerTick(6), 1)`);   // 加速到达上限（不改闸门相关默认值）
    for (let i = 0; i < 12; i++) { await m.pump(10); console.log('tick' + ((i+1)*10) + ':', JSON.stringify(await m.eval(S))); }
  } catch (e) { console.log('FATAL', (e && e.stack) || e); }
  finally { await m.close(); }
  process.exit(0);
})();
