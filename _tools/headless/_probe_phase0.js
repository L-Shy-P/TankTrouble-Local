'use strict';
/* 阶段0 探针【修复前版】：复现「倒计时内 teleport 静默失效」并量化倒计时帧数
 *
 * ⚠️ 这是【改 match.js 之前】的复现探针，留作证据（日志 prof/probe_phase0_before.log）。
 *    改完之后再跑它会看到 teleport 直接抛错（这正是我们要的"响亮失败"），
 *    所以"修好之后"的验收请看 _probe_phase0_fix.js。
 *
 *   node _tools/headless/_probe_phase0.js
 *
 * 依赖：现状的 match.js（open() 末尾不 waitForRound）—— open() 结束时通常仍在 COUNTING_DOWN。
 */
const { Match } = require('./match');

const ST = `(() => {
  var gc = GameManager.getGameController();
  var out = { state: null, states: null, tankKeys: null };
  try { out.state = gc.getState(); } catch (e) { out.stateErr = String(e && e.message || e); }
  try {
    if (typeof GameModel !== 'undefined' && GameModel._STATES) {
      out.states = { BETWEEN_ROUNDS: GameModel._STATES.BETWEEN_ROUNDS,
                     COUNTING_DOWN: GameModel._STATES.COUNTING_DOWN,
                     IN_ROUND: GameModel._STATES.IN_ROUND,
                     ENDED: GameModel._STATES.ENDED };
      out.gmGlobal = true;
    } else { out.gmGlobal = false; }
  } catch (e) { out.statesErr = String(e && e.message || e); }
  try {
    var d = __vtData(gc.getRoundState()) || {};
    var ts = (d.tankStates || [])[0];
    out.tankKeys = ts ? Object.keys(ts).sort() : null;
    out.tankSample = ts ? { id: ts.playerId, x: ts.x, y: ts.y, rot: ts.rotation,
      fwd: ts.forward, back: ts.back, left: ts.left, right: ts.right, fire: ts.fireDown } : null;
  } catch (e) { out.tankErr = String(e && e.message || e); }
  try { out.rng = window.__vtRng.state(); } catch (e) { out.rngErr = String(e && e.message || e); }
  return out;
})()`;

const TANKS = `(() => {
  var gc = GameManager.getGameController();
  var ids = __vtArr(gc.getActivePlayerIds());
  var out = {};
  for (var i = 0; i < ids.length; i++) {
    var t = gc.getTank(ids[i]);
    out[ids[i]] = t ? { x: t.getX(), y: t.getY(), rot: t.getRotation() } : null;
  }
  return out;
})()`;

(async () => {
  const m = new Match();
  const t0 = Date.now();
  try {
    await m.open({ verbose: true, humanIds: ['tank_a'], aiCount: 1 });
    console.log('open() 用时', Date.now() - t0, 'ms; bootstrap=', JSON.stringify(m.bootstrap));
    console.log('初始探针:', JSON.stringify(await m.eval(ST), null, 1));

    // ---- 倒计时内 teleport ----
    const before = await m.eval(TANKS);
    const ret = await m.teleport('tank_a', 55, 25, 1.0);
    const after = await m.eval(TANKS);
    console.log('【倒计时内 teleport】返回值 =', JSON.stringify(ret));
    console.log('  tank_a before =', JSON.stringify(before.tank_a));
    console.log('  tank_a after  =', JSON.stringify(after.tank_a));

    // ---- 逐帧等 IN_ROUND ----
    let inRoundAt = null;
    const timeline = [];
    let last = null;
    for (let f = 1; f <= 600; f++) {
      await m.pump(1, { yieldMs: 0 });
      const s = await m.eval('(()=>{var gc=GameManager.getGameController();return {st:gc.getState(),rid:gc.getRoundId()}})()');
      if (s.st !== last) { timeline.push(f + '帧→state=' + s.st); last = s.st; }
      if (s.st === 'in round') { inRoundAt = f; break; }   // GameModel._STATES 的值是【字符串】
    }
    console.log('状态时间线:', timeline.join(' | '));
    console.log('从 open() 返回到 IN_ROUND 用了', inRoundAt, '帧');

    // ---- 直接调 setTankState 看真实返回值（根因证据）----
    const direct = await m.eval(`(() => {
      var gc = GameManager.getGameController();
      var ts = TankState.withState('tank_a', 55, 25, false, false, 1.0, false, false, false, false);
      return { ret: gc.setTankState(ts, false), gcState: gc.getState() };
    })()`);
    console.log('【倒计时内直调 setTankState】返回 =', JSON.stringify(direct));

    // ---- IN_ROUND 后 teleport，逐字段读回 ----
    const r2 = await m.teleport('tank_a', 55, 25, 1.0);
    const read = await m.eval(TANKS);
    console.log('【IN_ROUND 后 teleport】返回值 =', JSON.stringify(r2));
    console.log('  tank_a 读回 =', JSON.stringify(read.tank_a));
    console.log('  期望 x=55 y=25 rot=1.0');

    console.log('帧末探针:', JSON.stringify(await m.eval(ST), null, 1));
    console.log('页面 console 里与 tank state 有关的行:',
      JSON.stringify(m.console.filter(function (l) { return /tank state|attempted to set/i.test(l); }).slice(0, 6)));
  } catch (e) {
    console.error('FAILED:', (e && e.stack) || e);
    process.exitCode = 1;
  } finally { await m.close(); }
})();
