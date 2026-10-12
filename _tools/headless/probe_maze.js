const { Match } = require('./match');
(async () => {
  const m = new Match();
  try {
    await m.open({ humanIds: ['tank_a','tank_b'], aiCount: 0 });
    await m.pump(150, { yieldMs: 6 });
    const r = await m.eval(`(() => {
      var out = {};
      var gc = GameManager.getGameController();
      var mz = gc.getMaze();
      out.type = typeof mz;
      out.keys = mz ? Object.keys(mz).slice(0,30) : null;
      out.proto = mz ? Object.getOwnPropertyNames(Object.getPrototypeOf(mz)).filter(k=>k!=='constructor').slice(0,30) : null;
      try { var d = __vtData(mz); out.dataType = typeof d; out.dataSample = JSON.stringify(d).slice(0, 500); } catch(e) { out.dataErr = String(e); }
      try { out.mazeMethods = {}; for (var k of ['getWidth','getHeight','getTileSize','getTiles','isWall','getGrid','getCell','getTheme']) out.mazeMethods[k] = typeof mz[k]; } catch(e){}
      return out;
    })()`);
    console.log(JSON.stringify(r, null, 1).slice(0, 2200));
  } catch (e) { console.error('FAILED:', (e && e.message) || e); }
  finally { await m.close(); }
})();
