'use strict';
/* 截图证明：无头环境里画的是真游戏画面，且 Laika 真的在动 */
const path = require('path');
const { Match } = require('./match');

(async () => {
  const m = new Match();
  try {
    await m.open();
    const shots = [];
    const marks = [];

    for (const [label, frames] of [['t0', 0], ['t1', 90], ['t2', 180], ['t3', 300], ['t4', 450]]) {
      if (frames) await m.pump(frames, { yieldMs: 6 });
      const s = await m.snapshot();
      const file = path.join(__dirname, `shot-${label}.png`);
      await m.screenshot(file);
      shots.push(file);
      marks.push({
        label,
        virtualT: +(s.virtualT / 1000).toFixed(2),
        tanks: s.tanks.map((t) => `${t.id}@(${t.x.toFixed(1)},${t.y.toFixed(1)})`),
        projectiles: s.projectiles.length,
        weapons: s.weapons.map((w) => `${w.owner}:${w.fired}/${w.bullets}`),
      });
    }
    console.log(JSON.stringify({ shots, marks }, null, 2));
  } catch (e) {
    console.error('FAILED:', (e && e.stack) || e);
    process.exitCode = 1;
  } finally { await m.close(); }
})();
