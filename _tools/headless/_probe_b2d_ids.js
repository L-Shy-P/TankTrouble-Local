'use strict';
const { Match } = require('./match');
(async () => {
  const m = new Match();
  try {
    await m.open({ humanIds: ['tank_a','tank_b'], aiCount: 0, control: false });
    await m.fast(5);
    const r = await m.eval(`(() => {
      var gc = GameManager.getGameController();
      var w = gc.getB2DWorld();
      var out = { bodyCount: w.m_bodyCount, bodies: [] };
      var b = w.GetBodyList(), n = 0;
      while (b && n < 8) {
        var ud = b.m_userData;
        var info = {
          n: n, type: b.m_type, flags: b.m_flags,
          sleepTime: b.m_sleepTime, awake: b.m_awake,
          hasSweep: !!b.m_sweep, sweepA0: b.m_sweep ? b.m_sweep.a0 : null,
          userDataType: typeof ud,
          userDataKeys: (ud && typeof ud === 'object') ? Object.keys(ud).slice(0, 18) : null,
          userDataStr: (ud === null || ud === undefined) ? String(ud) : null,
          fixtures: []
        };
        try {
          if (ud && typeof ud.getPlayerId === 'function') info.playerId = ud.getPlayerId();
          if (ud && typeof ud.getId === 'function') info.id = ud.getId();
          if (ud && ud.playerId !== undefined) info.udPlayerId = ud.playerId;
          if (ud && ud.id !== undefined) info.udId = ud.id;
        } catch (e) { info.udErr = String(e && e.message || e); }
        var fx = b.m_fixtureList, fn = 0;
        while (fx && fn < 6) {
          var sh = fx.m_shape || {};
          info.fixtures.push({
            n: fn, type: sh.m_type, radius: sh.m_radius, vcount: sh.m_vertexCount,
            category: fx.m_filter ? fx.m_filter.categoryBits : null,
            mask: fx.m_filter ? fx.m_filter.maskBits : null,
            group: fx.m_filter ? fx.m_filter.groupIndex : null,
            density: fx.m_density, isSensor: fx.m_isSensor
          });
          fx = fx.m_next; fn++;
        }
        out.bodies.push(info);
        b = b.m_next; n++;
      }
      return out;
    })()`);
    console.log(JSON.stringify(r, null, 1).slice(0, 4000));
  } catch (e) { console.error('FAILED', e && e.stack || e); process.exitCode = 1; }
  finally { await m.close(); }
})();
