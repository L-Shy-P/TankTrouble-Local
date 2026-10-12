const { Match } = require('./match');
(async () => {
  const m = new Match();
  try {
    await m.open({ humanIds: ['tank_a','tank_b'], aiCount: 0 });
    await m.pump(150, { yieldMs: 6 });
    const r = await m.eval(`(() => {
      var out = {};
      out.TankStateType = typeof TankState;
      if (typeof TankState === 'object') out.TankStateKeys = Object.keys(TankState).slice(0,20);
      out.hasWithState = typeof (typeof TankState !== 'undefined' && TankState.withState);
      out.hasCreate = typeof (typeof TankState !== 'undefined' && TankState.create);
      var gc = GameManager.getGameController();
      var t = gc.getTank('tank_a');
      out.tankClass = t.className ? t.className() : '?';
      out.tankMethods = Object.getOwnPropertyNames(Object.getPrototypeOf(t)).filter(k=>k!=='constructor');
      try { out.body = !!t.getBody ? !!t.getBody() : 'no getBody'; } catch(e) { out.body='ERR'; }
      out.tankFields = Object.keys(t._data || t.data || {}).slice(0,25);
      return out;
    })()`);
    console.log(JSON.stringify(r, null, 1));
  } catch (e) { console.error('FAILED:', (e && e.message) || e); }
  finally { await m.close(); }
})();
