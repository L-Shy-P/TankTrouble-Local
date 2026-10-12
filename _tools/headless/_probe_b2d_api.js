'use strict';
const { Match } = require('./match');
(async () => {
  const m = new Match();
  try {
    await m.open({ humanIds: ['tank_a','tank_b'], aiCount: 0, control: false });
    const r = await m.eval(`(() => {
      var gc = GameManager.getGameController();
      var out = { hasGetB2DWorld: typeof gc.getB2DWorld, gcKeys: Object.keys(gc).slice(0,40) };
      var w = null; try { w = gc.getB2DWorld(); } catch (e) { out.err = String(e && e.message || e); }
      out.world = w ? { ctor: w.constructor && w.constructor.name, getBodyList: typeof w.GetBodyList, keys: Object.keys(w).slice(0,40) } : null;
      if (w) {
        try {
          var b = w.GetBodyList(); var n = 0; var sample = null;
          while (b && n < 3) { n++; if (!sample) sample = { ctor: b.constructor && b.constructor.name, keys: Object.keys(b).slice(0,30), getPos: typeof b.GetPosition, m_xf: !!b.m_xf, m_linearVelocity: b.m_linearVelocity ? {x:b.m_linearVelocity.x,y:b.m_linearVelocity.y} : null }; b = b.GetNext ? b.GetNext() : b.m_next; }
          out.bodyCountSample = n; out.bodySample = sample;
        } catch (e) { out.bodyErr = String(e && e.message || e); }
      }
      return out;
    })()`);
    console.log(JSON.stringify(r, null, 2));
  } catch (e) { console.error('FAILED', e && e.stack || e); process.exitCode = 1; }
  finally { await m.close(); }
})();
