'use strict';
/* rot 断链定位第二探：逐环检查
 *   环1: TankState.withState 造出来的 state 里 rotation 对不对
 *   环2: setTankState 之后 tank.rotation 对不对
 *   环3: b2d body 角度对不对
 */
const { Match } = require('./match');

(async () => {
  const m = new Match();
  try {
    await m.open({ humanIds: ['tank_a', 'tank_b'], aiCount: 0, vantCount: 0 });
    await m.clearControl();
    const r = await m.eval(`(() => {
      var gc = GameManager.getGameController();
      var out = {};
      var ts = TankState.withState('tank_a', 55, 45, false, false, 1.0, false, false, false, false);
      out.stateRot = ts.getRotation();
      out.stateX = ts.getX();
      out.stateKeys = Object.keys(ts.data || {});
      gc.setTankState(ts, false);
      var t = gc.getTank('tank_a');
      out.tankRot = t ? t.getRotation() : null;
      out.tankX = t ? t.getX() : null;
      try { out.bodyAngle = t.b2dbody ? t.b2dbody.GetAngle() : 'no body'; } catch (e) { out.bodyAngle = 'err:' + e.message; }
      return out;
    })()`);
    console.log(JSON.stringify(r, null, 2));
  } catch (e) {
    console.error('FAILED:', (e && e.stack) || e);
    process.exitCode = 1;
  } finally { await m.close(); }
})();
