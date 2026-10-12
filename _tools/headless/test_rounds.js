'use strict';
/* 回合会不会自动重开？如果会，训练里 reset() 就是免费的 */
const { Match } = require('./match');

(async () => {
  const m = new Match();
  try {
    await m.open({ aiCount: 1 });
    const log = [];
    let lastRound = null, lastStage = null, lastTanks = null;
    for (let i = 0; i < 120; i++) {
      await m.pump(100, { yieldMs: 0 });
      const s = await m.snapshot();
      const tanks = s.tanks.map((t) => t.id).sort().join('+');
      const key = s.roundId + '|' + s.stage + '|' + tanks;
      if (key !== lastRound) {
        const sc = {};
        for (const x of s.scores) sc[x.playerId] = (sc[x.playerId] || 0) + x.value;
        log.push({ f: (i + 1) * 100, t: +(s.virtualT / 1000).toFixed(1), round: s.roundId, stage: s.stage, tanks, scores: sc });
        lastRound = key;
      }
      lastStage = s.stage; lastTanks = tanks;
    }
    console.log(JSON.stringify({ transitions: log, totalFrames: 12000 }, null, 1));
  } catch (e) {
    console.error('FAILED:', (e && e.stack) || e);
    process.exitCode = 1;
  } finally { await m.close(); }
})();
