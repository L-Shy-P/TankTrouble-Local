'use strict';
/* \u5f00\u5c40\u5efa\u8868\u7684\u4ee3\u4ef7\uff08\u672c\u5c40\u771f\u5b9e\u5c3a\u5bf8 12x8 \u53ca\u540c\u7c7b\uff09\uff1aNode \u4fa7\u5899\u949f */
const { Match } = require('./match');
(async () => {
  const m = new Match();
  const t = async (expr) => { const a = process.hrtime.bigint(); const v = await m.eval(expr); const b = process.hrtime.bigint();
    return { ms: Math.round(Number(b - a) / 1e6 * 10) / 10, v: v }; };
  try {
    await m.open({ humanIds: ['tank_a'], aiCount: 1, vantCount: 2, bootFrames: 300, rebaseAtMenu: true });
    const real = await m.eval(`(() => { var mz = GameManager.getGameController().getMaze();
      return { w: mz.getWidth(), h: mz.getHeight(), tiles: mz.getWidth()*mz.getHeight() }; })()`);
    console.log('  \u672c\u5c40\u8ff7\u5bab: ' + JSON.stringify(real) + '  \u8868\u683c\u4f4d=' + (real.tiles*real.tiles));
    const r1 = await t(`(() => { var mz = GameManager.getGameController().getMaze(); var x = VantageSandbox.buildNextTileTable(mz); return x.computed; })()`);
    console.log('  \u672c\u5c40\u8ff7\u5bab \u5efa\u8868\uff08Node \u5899\u949f\uff09: ' + r1.ms + ' ms (computed=' + r1.v + ')');
    for (const sz of [[8,6],[12,8],[14,9]]) {
      const r = await t(`(() => { var mz = Maze.createRandom(${sz[0]}, ${sz[1]}, ['tank_a','vantage_1'], 0); var x = VantageSandbox.buildNextTileTable(mz); return { c: x.computed, w: x.w, h: x.h }; })()`);
      console.log('  ${sz[0]}x${sz[1]}: ' + r.ms + ' ms  ' + JSON.stringify(r.v));
    }
    console.log('  getNavTableStatus = ' + JSON.stringify(await m.eval('VantageSandbox.getNavTableStatus()')));
  } catch (e) { console.error('FATAL', (e && e.message) || e); }
  finally { try { await m.close(); } catch (e) {} }
})();
