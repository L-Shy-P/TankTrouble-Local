#!/usr/bin/env node
'use strict';
/* 阶段2-1 自证探针：对【真实对局】调用 adapter 的每个新方法/新字段，打印返回值，证明不是 undefined。
 *
 * 判定：
 *   · A 组 = 真实对局初始态（bootcamp 2 人：tank_a / tank_b）
 *   · B 组 = 用**游戏自己的 API**造出真实对象后（子弹/道具/地雷/区域/计时器/护盾）
 *   · 每个新成员都必须在 B 组拿到非 null/undefined 的值（个别天然为空的项在报告里注明）
 *
 * 用法：node _tools/headless/_probe_adapter_2_1_getters.js
 * 退出码：0=PASS，1=FAIL。
 */
const fs = require('fs'), path = require('path');
const { Match } = require('./match');

const PRE = `
  var gc = GameManager.getGameController();
  var AD = VantageSandbox.createAdapter(gc, 'tank_a');
  function keys(o){ try { return Object.keys(o || {}); } catch (e) { return []; } }
  function pick1(map, fn) { var ks = keys(map); if (!ks.length) return null; return fn(map[ks[0]], ks[0]); }
  function tryv(fn) { try { return fn(); } catch (e) { return 'ERR:' + String((e && e.message) || e).slice(0, 120); } }
`;

const READ_ALL = `
(() => {
${PRE}
  var out = {};
  var t = AD.getTank('tank_b');
  out.getTank = t ? { x: t.getX(), y: t.getY(), rot: t.getRotation(),
                      fwd: t.getForward(), fire: t.getFireDown(), locked: t.getLocked() } : null;
  var tanks = AD.getTanks();
  out.getTanks = { n: keys(tanks).length, ids: keys(tanks) };
  out.getTankState = AD.getTankState();
  out.getProjectiles = (AD.getProjectiles() || []).map(function (p) {
    return { id: p.id, type: p.type, x: p.x, y: p.y, vx: p.speedX, vy: p.speedY, lifeLeft: p.lifeLeft };
  });
  // 与活对象对账：lifeLeft 必须 == lifetime − getTimeAlive()
  out.lifeLeft_check = (function () {
    var live = gc.getProjectiles(), res = [];
    for (var id in live) {
      var p0 = live[id];
      var lt = (typeof p0.lifetime === 'number') ? p0.lifetime - p0.getTimeAlive() : null;
      var row = null;
      for (var i = 0; i < out.getProjectiles.length; i++) if (out.getProjectiles[i].id === id) row = out.getProjectiles[i];
      res.push({ id: id, lifeTotal: p0.lifetime, timeAlive: +(+p0.getTimeAlive()).toFixed(4),
                 expect: (lt === null ? null : +lt.toFixed(4)), got: (row ? +(+row.lifeLeft).toFixed(4) : null),
                 match: (row && lt !== null) ? Math.abs(row.lifeLeft - lt) < 1e-9 : false });
    }
    return res;
  })();
  var col = AD.getCollectibles();
  out.getCollectibles = { n: keys(col).length, sample: pick1(col, function (c, id) {
    return { id: id, type: c.getType(), x: +(+c.getX()).toFixed(2), y: +(+c.getY()).toFixed(2), rot: +(+c.getRotation()).toFixed(3) }; }) };
  var tr = AD.getTraps();
  out.getTraps = { n: keys(tr).length, sample: pick1(tr, function (m, id) {
    return { id: id, type: m.getType(), x: +(+m.getX()).toFixed(2), y: +(+m.getY()).toFixed(2),
             activated: m.getField('activated'), tripped: m.getField('tripped'), detonated: m.getField('detonated'),
             detonationTime: m.getField('detonationTime'), timeAlive: +(+m.getTimeAlive()).toFixed(3) }; }) };
  var zn = AD.getZones();
  out.getZones = { n: keys(zn).length, sample: pick1(zn, function (z, id) {
    return { id: id, type: z.getType(), tiles: (z.getTiles() || []).length,
             lifetime: (z.getField ? z.getField('lifetime') : null),
             expansionTime: (z.getField ? z.getField('expansionTime') : null),
             expansionSide: (z.getField ? z.getField('expansionSide') : null),
             expansionSeqLen: (z.getField && z.getField('expansionSequence')) ? z.getField('expansionSequence').length : null }; }) };
  var up = tryv(function () { var u = AD.getUpgradeByPlayerIdAndType('tank_a', 2); return u ? {
      id: u.getId(), type: u.getType(), lifetime: u.getField('lifetime'), weakened: u.getField('weakened') } : null; });
  out.getUpgradeByPlayerIdAndType = up;
  var ws = AD.getWeaponStates('tank_a');
  out.getWeaponStates = { playerId: ws.playerId,
    active: ws.active ? { id: ws.active.id, type: ws.active.type, fields: ws.active.fields } : null,
    defaultType: ws['default'] ? ws['default'].type : null,
    queued: (ws.queued || []).map(function (w) { return { id: w.id, type: w.type }; }) };
  out.getTeam = tryv(function () { return AD.getTeam('tank_a'); });
  out.getScores = keys(AD.getScores()).map(function (k) { var s = AD.getScores()[k];
    return { playerId: s.getPlayerId(), type: s.getType(), value: s.getValue() }; });
  out.getScoreByPlayerIdAndType = tryv(function () { var s = AD.getScoreByPlayerIdAndType('tank_a', 0);
    return s ? { playerId: s.getPlayerId(), type: s.getType(), value: s.getValue() } : null; });
  out.getCounters = AD.getCounters();
  out.getState = AD.getState();
  out.getMatchConfig = AD.getMatchConfig();
  function rsSum(rs) { if (!rs) return null; var d = rs.data || {};
    return { tankStates: (d.tankStates || []).length, projectileStates: (d.projectileStates || []).length,
             collectibleStates: (d.collectibleStates || []).length, trapStates: (d.trapStates || []).length,
             weaponStates: (d.weaponStates || []).length, upgradeStates: (d.upgradeStates || []).length,
             counterStates: (d.counterStates || []).length, zoneStates: (d.zoneStates || []).length,
             isExpanded: rs.isExpanded ? rs.isExpanded() : null }; }
  out.getRoundState_false = rsSum(AD.getRoundState(false));
  out.getRoundState_true  = rsSum(AD.getRoundState(true));
  return out;
})()`;

const SETUP = `
(() => {
  var gc = GameManager.getGameController();
  var rc = gc.roundController;
  var maze = gc.getMaze();
  var out = { steps: [] };
  function step(name, fn) { try { out.steps.push({ name: name, ok: true, v: fn() }); }
                           catch (e) { out.steps.push({ name: name, ok: false, err: String((e && e.message) || e).slice(0, 160) }); } }

  // ① 按键：直接给 tank_a 一条 input（setInputState 立即写进 Tank，不必等帧）
  step('input.forward=true', function () {
    rc.setInputState(InputState.withState('tank_a', true, false, false, false, false));
    var t = gc.getTank('tank_a');
    return { tank_forward: t.getForward() };
  });
  // ② 开火：直接走游戏的 pullTrigger（RoundController.update 里的同一条路径），
  //    不依赖"按住键等帧"——本地客户端每帧会用键盘状态覆写 InputState，一次性注入会被冲掉。
  step('input.fire=true(同帧读)', function () {
    rc.setInputState(InputState.withState('tank_a', false, false, false, false, true));
    var k = { tank_fireDown: gc.getTank('tank_a').getFireDown() };
    // ★ locked 陷阱（同一帧内做，避免被 update 覆写）：
    var t = gc.getTank('tank_a');
    t.setLocked(true);
    k.locked_getter = { forward: t.getForward(), fireDown: t.getFireDown(), speed: t.getSpeed(),
                        rotationSpeed: t.getRotationSpeed(), raw_forward: t.forward, raw_fireDown: t.fireDown };
    t.setLocked(false);
    rc.setInputState(InputState.withState('tank_a', false, false, false, false, false));
    return k;
  });
  step('pullTrigger -> 真子弹', function () {
    rc.pullTrigger('tank_a');
    return { projectiles: Object.keys(gc.getProjectiles() || {}).length,
             bulletsFired: gc.getActiveWeapon('tank_a').getField('bulletsFired') };
  });
  // ③ 道具：用游戏自己的 spawnCrate（GameMode.update 里就是这条路径）
  step('spawnCrate(MINE=4)', function () {
    var pos = maze.getRandomUnusedPosition(gc.getRoundState(true), 3);
    if (!pos) return 'no free position';
    rc.spawnCrate(4, pos);
    return { x: +pos.x.toFixed(2), y: +pos.y.toFixed(2) };
  });
  // ④ 地雷：用 Mine.createInitialTrapState（Trap 的真实建体路径）
  step('trap(Mine)', function () {
    var pos = maze.getRandomUnusedPosition(gc.getRoundState(true), 3);
    if (!pos) return 'no free position';
    rc.setTrapState(Mine.createInitialTrapState('probe_mine_1', 'tank_b', pos.x, pos.y, 0, 0));
    return { x: +pos.x.toFixed(2), y: +pos.y.toFixed(2) };
  });
  // ⑤ 区域：用 SpawnZone（DM 复活圈的同一路径；非物理，放远一点不杀人）
  step('zone(SpawnZone)', function () {
    // 挑一个【离两辆坦克最远】的可达格：SpawnZone 是杀人区（TANK_ZONE_COLLISION → destroyTank），
    // 不能随手放（放近处会把 tank_a 杀了，后面的读数全废）。
    var tanks = gc.getTanks(), T = Constants.MAZE_TILE_SIZE.m, best = null, bestD = -1;
    for (var i = 0; i < (maze.reachable || []).length; i++) {
      var p = maze.reachable[i], cx = (p.x + 0.5) * T, cy = (p.y + 0.5) * T, dmin = 1e9;
      for (var id in tanks) { var t = tanks[id]; var dx = cx - t.getX(), dy = cy - t.getY();
        var d = Math.sqrt(dx * dx + dy * dy); if (d < dmin) dmin = d; }
      if (dmin > bestD) { bestD = dmin; best = p; }
    }
    if (!best) return 'no reachable tile';
    rc.setZoneState(SpawnZone.createInitialZoneState('probe_zone_1', [{ x: best.x, y: best.y }],
                                                    Constants.SPAWN_ZONE_LIFETIME, Constants.SPAWN_ZONE_START_RADIUS));
    return { tile: { x: best.x, y: best.y }, minDistToTank: +bestD.toFixed(2) };
  });
  // ⑥ 计时器：用 TimerCountdownCounter（DM 回合倒计时的同一路径）
  step('counter(TimerCountdown)', function () {
    rc.setCounterState(TimerCountdownCounter.createInitialCounterState('probe_counter_1', 60, 60));
    return { start: 60 };
  });
  // ⑦ 护盾：用 ShieldUpgrade.createInitialUpgradeState（拾取护盾箱的同一路径）
  step('upgrade(Shield)', function () {
    rc.setUpgradeState(ShieldUpgrade.createInitialUpgradeState('probe_shield_1', 'tank_a', Constants.SHIELD_LIFETIME));
    return { lifetime: Constants.SHIELD_LIFETIME };
  });
  return out;
})()`;

const LOCKED_DEMO = `
(() => {
  var gc = GameManager.getGameController();
  var AD = VantageSandbox.createAdapter(gc, 'tank_a');
  var t = gc.getTank('tank_a');
  var before = { forward: t.getForward(), fireDown: t.getFireDown(), raw_forward: t.forward, raw_fireDown: t.fireDown };
  t.setLocked(true);
  var st = AD.getTankState();
  var after = { locked: t.getLocked(), forward: t.getForward(), fireDown: t.getFireDown(),
                raw_forward: t.forward, raw_fireDown: t.fireDown,
                adapter_locked: st.locked, adapter_forward: st.forward, adapter_fireDown: st.fireDown,
                adapter_speed: st.speed, adapter_rotationSpeed: st.rotationSpeed };
  t.setLocked(false);
  return { before: before, after: after,
           note: 'locked=true 时 5 个按键 getter + speed/rotationSpeed 全被吞；raw 字段仍是真值' };
})()`;

(async () => {
  const m = new Match();
  let pass = 0, fail = 0;
  const fails = [];
  function check(name, ok, detail) {
    if (ok) pass++; else { fail++; fails.push(name); }
    console.log((ok ? 'PASS  ' : 'FAIL  ') + name.padEnd(38) + (detail === undefined ? '' : '  ' + String(detail).slice(0, 240)));
  }
  try {
    await m.open({ humanIds: ['tank_a', 'tank_b'], aiCount: 0, vantCount: 0, control: false, rng: 'record' });
    const A = await m.eval(READ_ALL);
    console.log('=== A 组：真实对局初始态 ===');
    console.log(JSON.stringify(A, null, 1).slice(0, 4000));

    const S = await m.eval(SETUP);
    console.log('=== 场景搭建（全部用游戏自己的 API）===');
    console.log(JSON.stringify(S));

    await m.pump(8);                      // 让子弹真的飞出来
    await m.eval("(() => { var gc = GameManager.getGameController(); gc.roundController.setInputState(InputState.withState('tank_a', false, false, false, false, false)); return 1; })()");
    await m.pump(2);

    const B = await m.eval(READ_ALL);
    console.log('=== B 组：造出真实对象后 ===');
    console.log(JSON.stringify(B, null, 1).slice(0, 6000));

    const L = { after: (S.steps[1] && S.steps[1].v) ? S.steps[1].v.locked_getter : null };
    console.log('=== locked 陷阱（真实 Tank，同一帧内）===');
    console.log(JSON.stringify(L));

    console.log('=== 自证判定（B 组每个新成员都必须是真数据）===');
    check('getTank -> 对手坦克对象', !!B.getTank && typeof B.getTank.x === 'number', JSON.stringify(B.getTank));
    check('getTanks -> 2 辆', B.getTanks && B.getTanks.n >= 2, JSON.stringify(B.getTanks));
    check('getTankState.x/y/rot 仍在', B.getTankState && typeof B.getTankState.x === 'number' &&
          typeof B.getTankState.rot === 'number', 'keys=' + Object.keys(B.getTankState || {}).join(','));
    check('getTankState.ammo 有值', !!B.getTankState.ammo && B.getTankState.ammo.type !== null, JSON.stringify(B.getTankState.ammo));
    check('getTankState.shield 有值(B组已造盾)', !!B.getTankState.shield && B.getTankState.shield.lifetime !== null,
          JSON.stringify(B.getTankState.shield));
    check('getProjectiles.lifeLeft 有值', Array.isArray(B.getProjectiles) && B.getProjectiles.length > 0 &&
          B.getProjectiles.every(p => typeof p.lifeLeft === 'number'), 'n=' + (B.getProjectiles || []).length);
    check('lifeLeft == lifetime-timeAlive', Array.isArray(B.lifeLeft_check) && B.lifeLeft_check.length > 0 &&
          B.lifeLeft_check.every(r => r.match), JSON.stringify((B.lifeLeft_check || [])[0]));
    check('getCollectibles -> 道具', B.getCollectibles && B.getCollectibles.n > 0, JSON.stringify(B.getCollectibles));
    check('getTraps -> 地雷', B.getTraps && B.getTraps.n > 0, JSON.stringify(B.getTraps));
    check('getZones -> 区域', B.getZones && B.getZones.n > 0, JSON.stringify(B.getZones));
    check('getUpgradeByPlayerIdAndType -> 护盾', !!B.getUpgradeByPlayerIdAndType &&
          B.getUpgradeByPlayerIdAndType.type === 2, JSON.stringify(B.getUpgradeByPlayerIdAndType));
    check('getWeaponStates -> 活武器', !!B.getWeaponStates && !!B.getWeaponStates.active &&
          B.getWeaponStates.active.type !== null, JSON.stringify(B.getWeaponStates).slice(0, 200));
    check('getTeam -> 恒 0（NO_TEAM）', B.getTeam === 0, 'value=' + JSON.stringify(B.getTeam));
    check('getScores -> 每人 2 条', Array.isArray(B.getScores) && B.getScores.length >= 4, 'n=' + (B.getScores || []).length);
    check('getScoreByPlayerIdAndType -> 有值', !!B.getScoreByPlayerIdAndType, JSON.stringify(B.getScoreByPlayerIdAndType));
    check('getCounters -> 计时器', Array.isArray(B.getCounters) && B.getCounters.length > 0 &&
          B.getCounters[0].currentTime !== null, JSON.stringify(B.getCounters));
    check('getState -> 字符串', typeof B.getState === 'string' && B.getState.length > 0, B.getState);
    check('getMatchConfig.crateTypes 有值', !!B.getMatchConfig && Array.isArray(B.getMatchConfig.crateTypes) &&
          B.getMatchConfig.crateTypes.length > 0, JSON.stringify(B.getMatchConfig));
    check('getRoundState(true) 有 trap/zone/counter 段', !!B.getRoundState_true &&
          B.getRoundState_true.trapStates > 0 && B.getRoundState_true.zoneStates > 0 &&
          B.getRoundState_true.counterStates > 0, JSON.stringify(B.getRoundState_true));
    check('按键 raw 可读（置 fire=true 后 raw=true）', !!L.after && L.after.raw_fireDown === true, JSON.stringify(L.after));
    check('locked 吞按键（getter=false 而 raw=true）', !!L.after && L.after.fireDown === false && L.after.raw_fireDown === true &&
          L.after.speed === 0, JSON.stringify(L.after));
    check('x/y/rot 三字段未变语义（A 组就有）', A.getTankState && typeof A.getTankState.x === 'number' &&
          typeof A.getTankState.y === 'number' && typeof A.getTankState.rot === 'number', JSON.stringify(A.getTankState).slice(0, 160));
    console.log('SUMMARY ' + JSON.stringify({ pass: pass, fail: fail, fails: fails }));
  } catch (e) {
    console.error('PROBE FATAL ' + ((e && e.stack) || e));
    process.exitCode = 2;
  } finally {
    try { await m.close(); } catch (e) {}
  }
  if (fail) process.exitCode = 1;
})();
