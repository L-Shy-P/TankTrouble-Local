'use strict';
const { Match } = require('./match');
(async () => {
  const m = new Match();
  await m.open({ humanIds: ['tank_a','tank_b'], aiCount: 0, vantCount: 0, rebaseAtMenu: true, bootFrames: 300 });
  const dt = await m.eval('window.__vt.dt');
  const info0 = await m.eval(`(() => {
    const g = GameManager.getGame();
    return { vtDt: window.__vt.dt, gDelta: g._deltaTime, updates: g.updatesThisFrame, tNow: g.time ? g.time.now : null, elapsed: g.time ? g.time.elapsed : null };
  })()`);
  // wrap RoundModel.update（只读探针，运行时包裹，不改磁盘代码）
  await m.eval(`(() => {
    window.__dtLog = [];
    const gc = GameManager.getGameController();
    const rm = gc.roundController.model;
    if (!rm.__origUpdate) {
      rm.__origUpdate = rm.update;
      rm.update = function (dt) {
        try { window.__dtLog.push({ steps: window.__vt.steps, vt: Math.round(window.__vt.t * 1000) / 1000, dtMs: dt * 1000 }); } catch (e) {}
        return rm.__origUpdate.call(this, dt);
      };
    }
    return true;
  })()`);
  await m.pump(12);
  const log = await m.eval('window.__dtLog.slice(0, 12)');
  const info1 = await m.eval(`(() => { const g = GameManager.getGame(); return { gDelta: g._deltaTime, updates: g.updatesThisFrame, now: g.time ? g.time.now : null }; })()`);
  console.log(JSON.stringify({ dt, info0, log, info1 }, null, 1));
  await m.close();
})().catch((e) => { console.error((e && e.stack) || e); process.exitCode = 1; });
