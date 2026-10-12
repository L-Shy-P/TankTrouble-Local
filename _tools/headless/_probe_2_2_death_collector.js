#!/usr/bin/env node
'use strict';
/* ============================================================================
 * 阶段 2-2 自证探针：死亡事件采集器（订阅式，**不 wrap 任何游戏方法**）
 *
 * 目的（对着真实对局验，不是 VM 假对象）：
 *   ① 4 类订阅事件各至少发生一次，且 `adapter.getDeaths()` / `getDeathHookStatus()` 真收到
 *        · TANK_DEADLY_COLLISION（弹杀上游，唯一带精确接触点 collisionPoint）
 *        · TANK_KILLED         （唯一带 killer / 弹种）
 *        · TANK_ZONE_COLLISION （区域致死上游；毒雾/出生区都走这条）
 *        · TANK_DESTROYED      （**只 wrap killTank 会 100% 漏掉的那条**；载荷是裸 pid 字符串）
 *   ② 「回调抛错 → 游戏不崩 + 我们自己的 catch 记到了」
 *      （RoundModel._notifyEventListeners 用 try/catch 吞异常，只 console.log）
 *   ③ collisionPoint 的几何含义实测样例（弹心 / 坦克质心 / 接触点三者的距离关系）
 *   ④ 幂等：同一个 gc 的 subCount 必须恰好 == 1
 *
 * 用法：node _tools/headless/_probe_2_2_death_collector.js
 * 退出码：0 = PASS，1 = FAIL
 * ⚠️ 本探针**只读产品代码**；它自己不改 game_core。
 * ============================================================================ */
const { Match } = require('./match');

const PRE = `
  var gc = GameManager.getGameController();
  var VS = VantageSandbox;
  var COL = VS.ensureDeathCollector(gc);
`;

/** 装采集器（幂等）+ 状态 */
const INSTALL = `(() => {
${PRE}
  var st = (VS.getDeathCollector(gc) || {});
  // 再装一次必须不走新订阅（幂等闸门）
  var again = VS.ensureDeathCollector(gc);
  return {
    installed: !!(st && st.installed),
    subCount: VS.createAdapter(gc, 'probe_adapter').getDeathHookStatus().subCount,
    sameObject: (again === COL),
    wrapped: false
  };
})()`;

/** 挑一对并排的可达格（A 与 A+(dx,dy)），把两辆坦克摆上去、面对面 */
const SETUP_PAIR = `(() => {
${PRE}
  var TILE = Constants.MAZE_TILE_SIZE.m;
  var maze = gc.getMaze();
  if (!maze) return { err: 'no maze' };
  var w = maze.width, h = maze.height;
  function inside(p) { try { return !!maze.isPositionInsideMaze(p); } catch (e) { return false; } }
  function connected(a, b) { try { return maze.getDistanceBetweenPositions(a, b) !== false; } catch (e) { return false; } }
  var dirs = [[2, 0], [0, 2], [-2, 0], [0, -2]];
  var best = null;
  var world = gc.getB2DWorld();
  function losClear(pa, pb) {
    // 直线无墙：B2DUtils.checkLineForMazeCollision 返回 true = 有墙挡住
    try {
      return B2DUtils.checkLineForMazeCollision(world, pa, pb) !== true;
    } catch (e) { return true; }   // 取不到 LoS 时按"通"处理，退回旧行为
  }
  for (var i = 0; i < w; i++) for (var j = 0; j < h; j++) {
    var a = { x: i, y: j };
    if (!inside(a)) continue;
    for (var d = 0; d < dirs.length; d++) {
      var b = { x: i + dirs[d][0], y: j + dirs[d][1] };
      if (!inside(b) || !connected(a, b)) continue;
      // ★ 视野内（直线无墙）才算 —— 否则子弹会先撞墙反弹（本轮第一次跑就是这样：
      //   tile(2,2)→(4,2) 的中间 (3,2) 是墙，弹在炮塔内生成 → 撞墙 → makeDeadlyToOwner
      //   → 反弹回来打死了自己，killer==victim）
      var wa0 = { x: (a.x + 0.5) * Constants.MAZE_TILE_SIZE.m, y: (a.y + 0.5) * Constants.MAZE_TILE_SIZE.m };
      var wb0 = { x: (b.x + 0.5) * Constants.MAZE_TILE_SIZE.m, y: (b.y + 0.5) * Constants.MAZE_TILE_SIZE.m };
      var clear = losClear(wa0, wb0);
      // 尽量靠中心（离边界的距离最大）；同样"靠中心"时优先有视野的
      var edge = Math.min(i, j, w - 1 - i, h - 1 - j);
      var score = (clear ? 1000 : 0) + edge;
      if (!best || score > best.score) best = { a: a, b: b, edge: edge, dir: dirs[d], los: clear, score: score };
    }
  }
  if (!best) return { err: 'no open adjacent pair' };
  var dx = best.dir[0], dy = best.dir[1];
  // 朝向约定（游戏本体）：forward = (sin r, -cos r) 且 y 向下
  var rotA, rotB;
  if (dx > 0) { rotA = Math.PI / 2; rotB = -Math.PI / 2; }
  else if (dx < 0) { rotA = -Math.PI / 2; rotB = Math.PI / 2; }
  else if (dy > 0) { rotA = Math.PI; rotB = 0; }
  else { rotA = 0; rotB = Math.PI; }
  var wa = { x: (best.a.x + 0.5) * TILE, y: (best.a.y + 0.5) * TILE };
  var wb = { x: (best.b.x + 0.5) * TILE, y: (best.b.y + 0.5) * TILE };
  return { a: best.a, b: best.b, wa: wa, wb: wb, rotA: rotA, rotB: rotB, edge: best.edge, w: w, h: h };
})()`;

/** 把两辆坦克摆到给定世界坐标（用游戏自己的 setTankState） */
const PLACE = (ax, ay, ar, bx, by, br) => `(() => {
${PRE}
  var out = {};
  var idA = 'tank_a', idB = 'tank_b';
  function put(id, x, y, rot) {
    var t = gc.getTank(id);
    if (!t) return { err: 'no tank ' + id };
    var ts = TankState.withState(id, x, y, false, false, rot, false, false, false, false);
    gc.setTankState(ts, false);
    var t2 = gc.getTank(id);
    return t2 ? { x: t2.getX(), y: t2.getY(), rot: t2.getRotation() } : { err: 'gone' };
  }
  out.a = put(idA, ${Number(ax)}, ${Number(ay)}, ${Number(ar)});
  out.b = put(idB, ${Number(bx)}, ${Number(by)}, ${Number(br)});
  out.gcState = gc.getState();
  return out;
})()`;

/** 一帧后：两辆坦克的位姿 + 存活 */
const POSES = `(() => {
${PRE}
  var out = {};
  ['tank_a', 'tank_b'].forEach(function (id) {
    var t = gc.getTank(id);
    out[id] = t ? { x: +t.getX().toFixed(4), y: +t.getY().toFixed(4), rot: +t.getRotation().toFixed(4) } : null;
  });
  out.gcState = gc.getState();
  out.deaths = VS.getDeathCollector(gc).deaths.length;
  out.errors = VS.getDeathCollector(gc).errors.length;
  out.live = Object.keys(gc.getTanks()).length;
  return out;
})()`;

/** 死亡记录 + 状态（值拷贝；含几何对照） */
const DEATHS = `(() => {
${PRE}
  var col = VS.getDeathCollector(gc);
  var AD = VS.createAdapter(gc, 'probe_adapter');
  return {
    status: AD.getDeathHookStatus(),
    deaths: AD.getDeaths(),
    lastRound: AD.getLastRoundDeaths(),
    rawErrors: col.errors.slice(0, 3),
    throwCount: VS.getDeathDebugThrowCount()
  };
})()`;

/** 在指定格子上放一个 SpawnZone（2-1 探针已验证：SpawnZone 是杀人区 → TANK_ZONE_COLLISION → destroyTank） */
const SPAWN_ZONE_ON = (tileX, tileY, id) => `(() => {
${PRE}
  var rc = gc.roundController;
  rc.setZoneState(SpawnZone.createInitialZoneState(${JSON.stringify(id)}, [{ x: ${Number(tileX)}, y: ${Number(tileY)} }],
    Constants.SPAWN_ZONE_LIFETIME, Constants.SPAWN_ZONE_START_RADIUS));
  var zs = gc.getZones();
  var ids = Object.keys(zs);
  var hit = null;
  for (var i = 0; i < ids.length; i++) if (ids[i] === ${JSON.stringify(id)}) hit = ids[i];
  return { created: hit, zoneTypes: ids.map(function (k) { return { id: k, type: zs[k].getType() }; }) };
})()`;

/** 放一个 StormZone（毒雾）；返回 tileBounds 与第一帧扩张后的方向 */
const STORM_ZONE = (id) => `(() => {
${PRE}
  var rc = gc.roundController;
  var maze = gc.getMaze();
  rc.setZoneState(StormZone.createInitialZoneState(${JSON.stringify(id)},
    maze.getStormExpansionSequence(), maze.getTileBounds()));
  var z = gc.getZones()[${JSON.stringify(id)}];
  return { ok: !!z, type: z ? z.getType() : null,
           bounds: z ? z._tileBounds : null,
           expansionSeq: z ? z._expansionSequence : null };
})()`;

/** 读毒雾扩张状态 */
const STORM_STATE = (id) => `(() => {
${PRE}
  var z = gc.getZones()[${JSON.stringify(id)}];
  if (!z) return { gone: true };
  return { t: z._expansionTime, side: z._expansionSide,
           r: z._expansionTilesRight, b: z._expansionTilesBottom,
           l: z._expansionTilesLeft, tp: z._expansionTilesTop,
           tiles: (z.tiles || []).length };
})()`;

/** 让毒雾立刻更新身体（把 _expansionTime 压到 <= START_GROW_TIME）——只改场景，不碰采集器 */
const STORM_FORCE_BODY = (id) => `(() => {
${PRE}
  var z = gc.getZones()[${JSON.stringify(id)}];
  if (!z) return { gone: true };
  z._expansionTime = Constants.STORM_ZONE_START_GROW_TIME;
  return { forced: z._expansionTime, side: z._expansionSide };
})()`;

const SET_THROW = (evt, mode) => `(() => { return { r: VantageSandbox.setDeathDebugThrow(${evt === null ? 'null' : JSON.stringify(evt)}${mode ? ", " + JSON.stringify(mode) : ''}) }; })()`;

/** 等下一回合开始且场上有 ≥1 辆坦克；返回 {frames,state,tanks,id} */
const WAIT_ROUND = `(() => {
${PRE}
  return { state: gc.getState(), tanks: Object.keys(gc.getTanks()),
           deaths: VS.getDeathCollector(gc).deaths.length,
           errors: VS.getDeathCollector(gc).errors.length, t: window.__vt.t };
})()`;

const ALIVE = `(() => {
${PRE}
  var out = { gcState: gc ? gc.getState() : null, hasRC: !!(gc && gc.roundController),
              tanks: Object.keys(gc.getTanks()).length, deaths: VS.getDeathCollector(gc).deaths.length,
              errors: VS.getDeathCollector(gc).errors.length, t: window.__vt.t, steps: window.__vt.steps };
  // 事件总线还活着吗：手动 emit 一个无副作用事件（TANK_CHANGED 走 RoundModel.emitTankState）
  var seen = 0;
  try {
    var probeCb = function () { seen++; };
    gc.roundController.addEventListener(probeCb, null, gc.getId());
    var t = gc.getTank('tank_a') || gc.getTank('tank_b');
    if (t) gc.roundController.model.emitTankState(t.getTankState());
    gc.roundController.removeEventListener(probeCb, null);
  } catch (e) { out.busErr = String((e && e.message) || e); }
  out.busSeen = seen;
  return out;
})()`;

/* --------------------------------------------------------------------------- */

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail === undefined ? null : detail });
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name.padEnd(46) + (detail === undefined ? '' : '  ' + String(detail).slice(0, 300)));
}
const J = (o, n) => JSON.stringify(o, null, 1).slice(0, n || 1200);

(async () => {
  const m = new Match();
  const report = { stages: {} };
  try {
    await m.open({ humanIds: ['tank_a', 'tank_b'], aiCount: 0, vantCount: 0, control: false, rng: 'record' });
    report.boot = { humanIds: m.bootstrap && m.bootstrap.humanIds, aiIds: m.bootstrap && m.bootstrap.aiIds, round: m.roundWait };

    /* ---------- S0 安装 ---------- */
    const s0 = await m.eval(INSTALL);
    report.stages.s0_install = s0;
    check('S0 采集器已装（订阅在 GameController 上）', s0.installed === true, 'installed=' + s0.installed);
    check('S0 幂等：同一 gc 再装不新增订阅，subCount === 1', s0.subCount === 1 && s0.sameObject === true,
      'subCount=' + s0.subCount + ' same=' + s0.sameObject);
    check('S0 没有 wrap 任何游戏方法（installDeathHook 未使用）', s0.wrapped === false);

    /* ---------- S1 摆位 ---------- */
    const pair = await m.eval(SETUP_PAIR);
    report.stages.s1_pair = pair;
    if (pair.err) throw new Error('S1 挑位失败: ' + pair.err);
    // 用 match.teleport（带读回校验，不一致会响亮抛错）——比自写 PLACE 安全
    await m.teleport('tank_a', pair.wa.x, pair.wa.y, pair.rotA);
    await m.teleport('tank_b', pair.wb.x, pair.wb.y, pair.rotB);
    await m.pump(2);
    const p1 = await m.eval(POSES);
    report.stages.s1_after = { poses: p1, teleportA: m.lastTeleport };
    check('S1 两辆坦克都摆到了目标格（teleport 读回一致）',
      !!(p1.tank_a && p1.tank_b &&
         Math.abs(p1.tank_a.x - pair.wa.x) < 1e-9 && Math.abs(p1.tank_a.y - pair.wa.y) < 1e-9 &&
         Math.abs(p1.tank_b.x - pair.wb.x) < 1e-9 && Math.abs(p1.tank_b.y - pair.wb.y) < 1e-9),
      'a=' + J(p1.tank_a).replace(/\s+/g, '') + ' b=' + J(p1.tank_b).replace(/\s+/g, ''));
    check('S1 摆位后两车都在场上', !!(p1.tank_a && p1.tank_b), 'live=' + p1.live);

    /* ---------- S2 弹杀：TANK_DEADLY_COLLISION + TANK_KILLED ---------- */
    await m.installControl('tank_a');
    await m.setControl({ fire: true });
    let killed = false, killFrames = 0;
    for (let i = 0; i < 120; i++) {
      await m.pump(1);
      killFrames++;
      const st = await m.eval(POSES);
      if (st.deaths > 0) { killed = true; break; }
      if (!st.tank_b) { killed = true; break; }
    }
    await m.clearControl();
    const d2 = await m.eval(DEATHS);
    report.stages.s2_after_kill = { killFrames, deaths: d2.deaths, status: d2.status };
    check('S2 弹杀触发（开了火并等到死亡）', killed, 'frames=' + killFrames);
    const recK = (d2.deaths || []).find((r) => r.victimPlayerId === 'tank_b') || (d2.deaths || [])[0];
    check('S2 TANK_KILLED 记到了（src/ killer/ 弹种）', !!(recK && recK.src === 'TANK_KILLED'),
      recK ? 'src=' + recK.src + ' killer=' + recK.killerPlayerId + ' type=' + recK.deadlyType + ' deadlyId=' + recK.deadlyId : 'no record');
    check('S2 死亡位置是【值拷贝】（x/y/rot 都是数，不是 tank 引用）',
      !!(recK && typeof recK.x === 'number' && typeof recK.y === 'number' && typeof recK.rot === 'number'),
      recK ? ('poseSrc=' + recK.poseSrc + ' x=' + recK.x + ' y=' + recK.y + ' rot=' + recK.rot) : 'no record');
    check('S2 TANK_DEADLY_COLLISION 的接触点回填了（顺序无关设计）',
      !!(recK && typeof recK.contactX === 'number' && typeof recK.contactY === 'number'),
      recK ? ('contactSrc=' + recK.contactSrc + ' contact=(' + recK.contactX + ',' + recK.contactY + ')') : 'no record');

    /* ---------- S5 collisionPoint 几何样例 ---------- */
    if (recK) {
      const geo = {
        victim: recK.victimPlayerId,
        tankCenter: { x: recK.x, y: recK.y },
        tankBody: (recK.bodyX === null ? null : { x: recK.bodyX, y: recK.bodyY }),
        contact: (recK.contactX === null ? null : { x: recK.contactX, y: recK.contactY }),
        normal: (recK.contactNx === null ? null : { x: recK.contactNx, y: recK.contactNy }),
        projectile: (recK.deadlyX === null ? null : { x: recK.deadlyX, y: recK.deadlyY, vx: recK.deadlyVx, vy: recK.deadlyVy }),
      };
      const dist = (a, b) => (a && b) ? +Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2).toFixed(4) : null;
      geo.d_contact_to_tankCenter = dist(geo.contact, geo.tankCenter);
      geo.d_contact_to_projectile = dist(geo.contact, geo.projectile);
      geo.d_proj_to_tankCenter = dist(geo.projectile, geo.tankCenter);
      geo.d_contact_to_tankBody = dist(geo.contact, geo.tankBody);
      report.stages.s5_geometry = geo;
      check('S5 collisionPoint ≠ 坦克质心（它是接触点，不是圆心投影）',
        !!(geo.d_contact_to_tankCenter !== null && geo.d_contact_to_tankCenter > 0.05),
        'd(contact, tankCenter)=' + geo.d_contact_to_tankCenter + ' m');
    }

    /* ---------- 等这一回合结束 / 下一回合开始 ---------- */
    let waited = 0;
    while (waited < 1200) { await m.pump(10); waited += 10; const st = await m.eval(POSES); if (st.gcState === 'in round' && st.live >= 2 && st.deaths === 0) break; }
    report.stages.s3_wait = { frames: waited, state: (await m.eval(POSES)).gcState, deaths: (await m.eval(POSES)).deaths };

    /* ---------- S4 区域致死 + 抛错注入 ---------- */
    const posNow = await m.eval(POSES);
    const aliveId = posNow.tank_a ? 'tank_a' : (posNow.tank_b ? 'tank_b' : null);
    if (aliveId) {
      const tileOf = await m.eval(`(() => {
${PRE}
        var TILE = Constants.MAZE_TILE_SIZE.m; var t = gc.getTank(${JSON.stringify(aliveId)});
        return t ? { x: Math.floor(t.getX() / TILE), y: Math.floor(t.getY() / TILE) } : null; })()`);
      const throwSet = await m.eval(SET_THROW('TANK_DESTROYED'));
      report.stages.s4_throw_on = throwSet;
      const before4 = await m.eval(DEATHS);
      const errBefore = before4.status.errors;
      const deathsBefore = before4.status.deaths;
      const zone = await m.eval(SPAWN_ZONE_ON(tileOf.x, tileOf.y, 'probe_zone_s4'));
      report.stages.s4_zone = zone;
      let sawErr = false, zoneFrames = 0;
      for (let i = 0; i < 40; i++) {
        await m.pump(1); zoneFrames++;
        const st = await m.eval(DEATHS);
        if (st.status.errors > errBefore) { sawErr = true; break; }
      }
      const d4 = await m.eval(DEATHS);
      report.stages.s4_after = { zoneFrames, status: d4.status, rawErrors: d4.rawErrors, deaths: d4.deaths, deathsBefore, errBefore };
      const alive4 = await m.eval(ALIVE);
      report.stages.s4_alive = alive4;
      check('S4 回调里故意抛错 → 我们自己的 catch 记到了 errors≥1', sawErr && d4.status.errors >= 1,
        'errors=' + d4.status.errors + ' throws=' + d4.throwCount + ' evt=' + (d4.rawErrors[0] && d4.rawErrors[0].evt));
      check('S4 抛错后【游戏不崩】：仍在回合中 + 事件总线仍可派发',
        !!(alive4.gcState === 'in round' && alive4.hasRC && alive4.busSeen >= 1),
        'state=' + alive4.gcState + ' hasRC=' + alive4.hasRC + ' busSeen=' + alive4.busSeen + ' tanks=' + alive4.tanks);
      check('S4 抛错发生在写记录之前 ⟹ 那条死亡【没有】被记成记录（错的只是我们这层，游戏事件照发）',
        d4.status.deaths === deathsBefore,
        'deathsBefore=' + deathsBefore + ' deathsAfter=' + d4.status.deaths);

      /* ---------- S5b 关掉抛错后，区域致死能被正常记录（采集器没卡死） ---------- */
      await m.eval(SET_THROW(null));
      let waited2 = 0;
      while (waited2 < 1200) { await m.pump(10); waited2 += 10; const st = await m.eval(POSES); if (st.gcState === 'in round' && st.live >= 1) break; }
      const pos2 = await m.eval(POSES);
      const id2 = pos2.tank_a ? 'tank_a' : (pos2.tank_b ? 'tank_b' : null);
      if (id2) {
        const tile2 = await m.eval(`(() => {
${PRE}
          var TILE = Constants.MAZE_TILE_SIZE.m; var t = gc.getTank(${JSON.stringify(id2)});
          return t ? { x: Math.floor(t.getX() / TILE), y: Math.floor(t.getY() / TILE) } : null; })()`);
        await m.eval(SPAWN_ZONE_ON(tile2.x, tile2.y, 'probe_zone_s5'));
        let got = false, fr2 = 0;
        for (let i = 0; i < 40; i++) {
          await m.pump(1); fr2++;
          const st = await m.eval(DEATHS);
          if ((st.deaths || []).some((r) => r.src === 'TANK_DESTROYED')) { got = true; break; }
        }
        const d5 = await m.eval(DEATHS);
        const recD = (d5.deaths || []).find((r) => r.src === 'TANK_DESTROYED');
        report.stages.s5b = { frames: fr2, deaths: d5.deaths, status: d5.status };
        check('S5b 区域致死（**不走 killTank**）被记到：src=TANK_DESTROYED', got,
          recD ? ('cause=' + recD.cause + ' contactSrc=' + recD.contactSrc + ' x=' + recD.x + ' y=' + recD.y) : 'no record');
        check('S5b 该记录带【值拷贝位置】（区域致死也能拿位置）',
          !!(recD && typeof recD.x === 'number' && typeof recD.y === 'number'),
          recD ? ('poseSrc=' + recD.poseSrc) : 'no record');
        check('S5b TANK_ZONE_COLLISION 也收到了（cause 是真实 zone 类型）',
          !!(recD && (recD.cause === 'spawn' || recD.cause === 'storm')), recD ? 'cause=' + recD.cause : 'no record');

        /* ---------- S4b 抛在【我们自己的 try 之外】：证明外层 try/catch 会吞掉它 ---------- */
        let w2 = 0;
        while (w2 < 1200) {
          await m.pump(10); w2 += 10;
          const st = await m.eval(WAIT_ROUND);
          if (st.state === 'in round' && st.tanks.length >= 1 && st.deaths === 0) break;
        }
        const pre4b = await m.eval(WAIT_ROUND);
        const t4b = await m.eval(`(() => {
${PRE}
          var TILE = Constants.MAZE_TILE_SIZE.m; var ks = Object.keys(gc.getTanks());
          if (!ks.length) return null;
          var t = gc.getTank(ks[0]);
          return { id: ks[0], x: Math.floor(t.getX() / TILE), y: Math.floor(t.getY() / TILE) }; })()`);
        if (t4b) {
          await m.eval(SET_THROW('TANK_DESTROYED', 'outer'));
          await m.eval(SPAWN_ZONE_ON(t4b.x, t4b.y, 'probe_zone_s4b'));
          let fr4b = 0;
          for (let i = 0; i < 40; i++) {
            await m.pump(1); fr4b++;
            const st = await m.eval(DEATHS);
            if (st.throwCount > 0) break;
          }
          const d4b = await m.eval(DEATHS);
          const alive4b = await m.eval(ALIVE);
          await m.eval(SET_THROW(null));
          report.stages.s4b = { frames: fr4b, pre: pre4b, status: d4b.status, alive: alive4b };
          check('S4b 抛在【自己 try 之外】：外层 try/catch 吞掉它 ⟹ 我们的 errors【不增】',
            d4b.status.errors === pre4b.errors, 'errors before=' + pre4b.errors + ' after=' + d4b.status.errors);
          check('S4b 即使异常逃到外层，游戏仍不崩（证明外层确实吞了，不是没抛）',
            !!(alive4b.gcState === 'in round' && alive4b.busSeen >= 1 && d4b.throwCount >= 1),
            'state=' + alive4b.gcState + ' busSeen=' + alive4b.busSeen + ' throws=' + d4b.throwCount);
        } else {
          check('S4b 找到一辆坦克做 outer 抛错实验', false, '没有坦克');
        }
      } else {
        check('S5b 关掉抛错后还能再开一局做区域致死', false, '没有存活坦克');
      }
    } else {
      check('S4 找到存活坦克做区域致死', false, '没有存活坦克');
    }
  } catch (e) {
    console.error('FATAL', (e && e.stack) || e);
    report.fatal = String((e && e.stack) || e);
  } finally {
    report.pageErrors = m.pageErrors.slice(0, 5);
    console.log('================ 汇总 ================');
    const fails = results.filter((r) => !r.ok);
    console.log('PASS ' + (results.length - fails.length) + '/' + results.length +
      (fails.length ? ('  FAIL: ' + fails.map((f) => f.name).join(' | ')) : '  ✅ 全 PASS'));
    console.log('REPORT_JSON_BEGIN');
    console.log(J(report, 60000));
    console.log('REPORT_JSON_END');
    await m.close();
    process.exitCode = fails.length ? 1 : 0;
  }
})();
