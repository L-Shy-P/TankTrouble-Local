'use strict';
/* 阶段0 探针2：可读的「初始条件」都有什么（地图/主题/玩家/回合设置） */
const { Match } = require('./match');

(async () => {
  const m = new Match();
  try {
    await m.open({ humanIds: ['tank_a', 'tank_b'], aiCount: 0 });
    for (let i = 0; i < 400; i++) {
      const st = await m.eval('GameManager.getGameController().getState()');
      if (st === 'in round') break;
      await m.pump(1, { yieldMs: 0 });
    }
    const r = await m.eval(`(() => {
      var gc = GameManager.getGameController();
      var out = {};
      var safe = function (fn) { try { return fn(); } catch (e) { return 'ERR:' + String(e && e.message || e); } };
      out.state = gc.getState();
      out.mode = safe(function () { return Constants.getMode(); });
      out.gcMode = safe(function () { return gc.getMode(); });
      out.theme = safe(function () { return gc.getTheme(); });
      out.consts = safe(function () { return {
        COUNTDOWN_DURATION: Constants.COUNTDOWN_DURATION,
        COUNTDOWN_START_VALUE: Constants.COUNTDOWN_START_VALUE,
        BETWEEN_ROUNDS_DURATION: Constants.BETWEEN_ROUNDS_DURATION,
        CELEBRATION_DURATION: Constants.CELEBRATION_DURATION,
        MAX_DELTA_TIME: Constants.MAX_DELTA_TIME,
        MAX_PLAYERS: Constants.CLIENT.MAX_PLAYERS,
        MAZE_THEMES: Constants.MAZE_THEMES,
      }; });
      out.flags = { ranked: gc.getRanked(), symmetric: gc.getSymmetric(), storm: gc.getStorm(), premium: gc.getPremium() };
      out.activeIds = __vtArr(gc.getActivePlayerIds());
      out.roundId = gc.getRoundId();
      var mz = gc.getMaze();
      out.mazeKeys = mz ? Object.keys(__vtData(mz) || {}).sort() : null;
      out.maze = safe(function () { return { width: mz.width, height: mz.height,
        tileSize: mz.tileSize, W: mz.getWidth ? mz.getWidth() : null,
        tankPositions: mz.getTankPositions ? JSON.parse(JSON.stringify(mz.getTankPositions())) : null,
        spawn: mz.tankSpawnPositions, reachableLen: (mz.reachable || []).length,
        crateSpawn: mz.crateSpawnPositions }; });
      // 地图格：用 isPositionInsideMaze 逐格探
      out.inside = safe(function () {
        var g = [], w = mz.width, h = mz.height;
        for (var y = 0; y < h; y++) { var row = ''; for (var x = 0; x < w; x++) {
          var inside = false;
          try { inside = !!mz.isPositionInsideMaze({ x: x * 10 + 5, y: y * 10 + 5 }); } catch (e) {}
          row += inside ? '.' : '#'; } g.push(row); }
        return g;
      });
      // roundState 的字段
      var d = __vtData(gc.getRoundState()) || {};
      out.roundStateKeys = Object.keys(d).sort();
      out.tankStates0 = (d.tankStates || []).map(function (t) { return { id: t.playerId, x: +t.x.toFixed(3), y: +t.y.toFixed(3), rot: +(+t.rotation).toFixed(5) }; });
      out.weaponKeys = (d.weaponStates || []).length ? Object.keys(d.weaponStates[0]).sort() : null;
      out.gameStateKeys = safe(function () { return Object.keys(__vtData(gc.getGameState()) || {}).sort(); });
      out.vtT = window.__vt.t;
      return out;
    })()`);
    console.log(JSON.stringify(r, null, 1));
  } catch (e) {
    console.error('FAILED:', (e && e.stack) || e);
    process.exitCode = 1;
  } finally { await m.close(); }
})();
