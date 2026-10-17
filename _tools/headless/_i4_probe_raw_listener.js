'use strict';
/* _i4_ 小探针：为什么我在 GameController.addRoundEventListener 上挂的【裸】监听器收不到事件？
 * 顺带把 STORM 致死的原始事件载荷抓一份（给报告用）。
 * 只读产品代码；产物 _tools/headless/_i4_prof/_i4_raw_listener.json
 */
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const { Match } = require('./match');
const PROF = path.join(__dirname, '_i4_prof');
const FILES = ['game_core/js/vantage_sandbox.js', 'game_core/js/46989e393ad0e356ac8a0c6c53b362f9.js', 'game_core/js/82e43ebfcdffdaf490dbe79c9c119d29.js'];
const T0 = Date.now();
const rep = { fingerprints: FILES.map((r) => { const p = path.join(__dirname, '..', '..', r);
  try { const st = fs.statSync(p); return { file: r, mtime: st.mtime.toISOString(), bytes: st.size, md5: crypto.createHash('md5').update(fs.readFileSync(p)).digest('hex') }; }
  catch (e) { return { file: r, err: String(e) }; } }) };
const P = (...a) => console.log(...a);
(async () => {
  let m;
  try {
    m = new Match();
    await m.open({ humanIds: ['tank_a', 'tank_b', 'tank_c'], aiCount: 0, vantCount: 0 });
    await m.clearControl();
    await m.eval('window.__ad = VantageSandbox.createAdapter(GameManager.getGameController(), "i4_raw")');
    // ① 极简监听器（不用 this，不引用 __vt）
    rep.minimal = await m.eval(`(() => {
      var gc = GameManager.getGameController();
      window.__n = 0; window.__evs = [];
      var cb = function (ctx, evt, data) { window.__n++; try { window.__evs.push(String(evt)); } catch (e) {} };
      gc.addRoundEventListener(cb, null);
      return { added: true, listenersOnGC: (gc.roundEventListeners || []).length,
               hasRoundController: !!gc.roundController,
               modelListeners: gc.roundController && gc.roundController.model ? gc.roundController.model.eventListeners.length : null };
    })()`);
    // ② 造毒雾 + 正确版强制 + 受害者
    rep.setup = await m.eval(`(() => {
      var gc = GameManager.getGameController(); var mz = gc.getMaze();
      gc.roundController.setZoneState(StormZone.createInitialZoneState('rawsz', mz.getStormExpansionSequence(), mz.getTileBounds()));
      var z = gc.getZones()['rawsz'];
      var tb = z._tileBounds, seq0 = z._expansionSequence[0];
      var midY = Math.round((tb.minY + tb.maxY) / 2), midX = Math.round((tb.minX + tb.maxX) / 2);
      var want = seq0 === 0 ? { x: tb.maxX, y: midY } : seq0 === 2 ? { x: tb.minX, y: midY } : seq0 === 1 ? { x: midX, y: tb.maxY } : { x: midX, y: tb.minY };
      var tiles = mz.getTiles();
      if (!(tiles[want.x] && tiles[want.x][want.y] && tiles[want.x][want.y][0] === 1)) {
        for (var i = 0; i < tiles.length; i++) for (var j = 0; j < tiles[i].length; j++) {
          if (tiles[i][j][0] === 1 && ((seq0 === 0 && i === tb.maxX) || (seq0 === 2 && i === tb.minX) || (seq0 === 1 && j === tb.maxY) || (seq0 === 3 && j === tb.minY))) { want = { x: i, y: j }; i = 1e9; break; }
        }
      }
      var TILE = Constants.MAZE_TILE_SIZE.m;
      var vx = want.x * TILE + TILE / 2, vy = want.y * TILE + TILE / 2;
      var t = gc.getTank('tank_b');
      gc.setTankState(TankState.withState('tank_b', vx, vy, false, false, 0, false, false, false, false), false);
      z._expansionSide = -1; z._expansionTime = Constants.STORM_ZONE_START_GROW_TIME;
      return { seq0: seq0, cell: want, world: [vx, vy], zoneType: z.getType(), isPhysical: z.isPhysical(),
               ZONE_TYPES: { SPAWN: Constants.ZONE_TYPES.SPAWN, HILL: Constants.ZONE_TYPES.HILL, BASE: Constants.ZONE_TYPES.BASE, STORM: Constants.ZONE_TYPES.STORM } };
    })()`);
    P('setup=' + JSON.stringify(rep.setup));
    // ③ 逐帧 pump 到死
    let dead = -1; let rawAtDeath = null;
    for (let i = 0; i < 400; i++) {
      const t = await m.eval("!!GameManager.getGameController().getTank('tank_b')");
      if (!t) { dead = i; rawAtDeath = await m.eval('({n:window.__n, evs:window.__evs.slice()})'); break; }
      await m.pump(1);
    }
    rep.deadAt = dead; rep.rawCount = rawAtDeath;
    // ④ 采集器记录
    rep.rec = await m.eval(`(() => { var d = window.__ad.getDeaths();
      var r = null; for (var i = 0; i < d.length; i++) if (d[i].victimPlayerId === 'tank_b') r = d[i];
      return { n: d.length, rec: r, status: window.__ad.getDeathHookStatus(),
               listenersOnGC: (GameManager.getGameController().roundEventListeners || []).length,
               modelListeners: GameManager.getGameController().roundController.model.eventListeners.length }; })()`);
    P('rawCount=' + JSON.stringify(rep.rawCount));
    P('rec=' + JSON.stringify(rep.rec));
    rep.pageErrors = m.pageErrors.slice(0, 4);
  } catch (e) { rep.err = String((e && e.stack) || e); P('X: ' + rep.err); }
  finally {
    try { if (m) await m.close(); } catch (e) {}
    try { fs.writeFileSync(path.join(PROF, '_i4_raw_listener.json'), JSON.stringify(rep, null, 1)); } catch (e) {}
    P('[done] ' + ((Date.now() - T0) / 1000).toFixed(1) + 's');
  }
})();
