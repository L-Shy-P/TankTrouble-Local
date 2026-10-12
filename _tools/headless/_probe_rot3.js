'use strict';
/* rot 断链定位第三探：setTankState 为什么静默无效 */
const { Match } = require('./match');

(async () => {
  const m = new Match();
  try {
    await m.open({ humanIds: ['tank_a', 'tank_b'], aiCount: 0, vantCount: 0 });
    await m.clearControl();
    const r = await m.eval(`(() => {
      var gc = GameManager.getGameController();
      var out = {};
      out.gcSrc = ('' + gc.setTankState).slice(0, 400);
      out.mode = Constants.getMode();
      out.MODE_CLIENT_LOCAL = Constants.MODE_CLIENT_LOCAL;
      out.hasGetTank = typeof gc.getTank;
      var t = gc.getTank('tank_a');
      out.tankBefore = t ? { x: t.getX(), rot: t.getRotation() } : null;
      // 直接调 model 层，绕过 controller 包装
      var ts = TankState.withState('tank_a', 55, 45, false, false, 1.0, false, false, false, false);
      try {
        var model = gc.getRoundModel ? gc.getRoundModel() : (gc.model || null);
        out.modelType = model ? 'yes' : 'no';
        if (model) {
          out.modelHasTank = !!(model.tanks && model.tanks['tank_a']);
          out.modelGetTank = model.getTank ? !!model.getTank('tank_a') : 'no getTank';
          model.setTankState(ts);
          var t2 = gc.getTank('tank_a');
          out.tankAfterModelSet = t2 ? { x: t2.getX(), rot: t2.getRotation() } : null;
        }
      } catch (e) { out.modelErr = String(e && e.message || e); }
      return out;
    })()`);
    console.log(JSON.stringify(r, null, 2));
  } catch (e) {
    console.error('FAILED:', (e && e.stack) || e);
    process.exitCode = 1;
  } finally { await m.close(); }
})();
