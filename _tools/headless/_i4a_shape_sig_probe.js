#!/usr/bin/env node
'use strict';
/* ============================================================================
 * 1-4-a 形状签名 + 候选体重建 —— 「改动真的生效」对照探针
 *
 * 目的（本项目老坑：**改完了但没生效**）：同一局面、换不同武器，证明
 *   ① 沙箱的**判死轮廓**（炮塔）确实跟着当前武器变（带数字：塔尖 / 多边形顶点差）
 *   ② 沙箱轮廓 == **真游戏自己那套夹具**（以 live body 的 `userData.type==='turret'`
 *      夹具反变换回局部坐标为 ground truth）
 *   ③ 同一颗弹、同一个位姿：**新代码**判死 5 死 2 活；**旧代码（写死炮弹炮塔）** 7 个全死
 *      ⟹ 修前必 FAIL / 修后必 PASS 的反向验证
 *   ④ 真游戏自己对同一局面也给出同样的分歧（双管 活 / 霰弹 死）
 *
 * 只读产品代码；只写 `_tools/headless/_i4a_prof/`。
 * 用法：node _tools/headless/_i4a_shape_sig_probe.js
 * ============================================================================ */
const fs = require('fs');
const path = require('path');
const { Match } = require('./match');

const OUT = path.join(__dirname, '_i4a_prof');
const DT = 0.02;
// 同一局面：受害坦克 rot=0（车头朝 -y），弹沿 +x 以 1 m/s 慢速穿过"车头正前方 2.80 m"
const GRAZE = 2.80;

/** 与 `_i4x_wpn_v5_measure.js` 同一入口注入武器（`roundController.setWeaponState`，
 *  即游戏自己的 `RoundModel.setWeaponState` → 内部会调 `updateTankBodyTurret`）。 */
const INSTALL = `(() => {
  var C = Constants;
  window.__i4a = {
    gc: function () { return GameManager.getGameController(); },
    inject: function (kind, id) {
      var gc = GameManager.getGameController(), ws = null;
      if (kind === 'HOMING') ws = HomingMissileWeapon.createInitialWeaponState(IdGenerator.instance.gen('hmw'), id);
      else if (kind === 'LASER') ws = LaserWeapon.createInitialWeaponState(IdGenerator.instance.gen('lw'), id);
      else if (kind === 'MINE') ws = MineWeapon.createInitialWeaponState(IdGenerator.instance.gen('mw'), id, C.MINE_AMMO_COUNT);
      else if (kind === 'SHOTGUN') ws = ShotgunWeapon.createInitialWeaponState(IdGenerator.instance.gen('sw'), id, C.SHOTGUN_AMMO_COUNT);
      else if (kind === 'DOUBLE_BARREL') ws = DoubleBarrelWeapon.createInitialWeaponState(IdGenerator.instance.gen('dbw'), id, C.DOUBLE_BARREL_AMMO_COUNT);
      else if (kind === 'GATLING') ws = GatlingGunWeapon.createInitialWeaponState(IdGenerator.instance.gen('ggw'), id, C.GATLING_GUN_AMMO_COUNT);
      else return { err: 'kind?' };
      // ⚠️ setWeaponState 把非默认武器 **unshift 进队列**，而 getActiveWeapon 取的是
      //    队列【最后一个】⟹ 不清队列的话第二把起完全没进 active（"我传了但其实没生效"）。
      //    探针侧先清空队列（游戏自己的数据结构），再注入 ⟹ 新武器 = 队列唯一项 = active。
      var rm = gc.roundController.model;
      if (rm && rm.playerIdOtherWeaponIds) rm.playerIdOtherWeaponIds[id] = [];
      gc.roundController.setWeaponState(ws);
      var aw = null; try { aw = gc.getActiveWeapon(id); } catch (eAw) { aw = null; }
      return { id: ws.getId(), type: ws.getType(), activeType: aw ? aw.getType() : null,
               turretFx: (function () {
                 var n = 0, t = gc.getTank(id);
                 if (t && t.getB2DBody()) { var f = t.getB2DBody().GetFixtureList();
                   while (f) { var u = null; try { u = f.GetUserData(); } catch (e) {}
                     if (u && u.type === 'turret') n++; f = f.GetNext(); } }
                 return n;
               })() };
    },
    /* 真游戏判死轮廓（ground truth）：live body 上 userData.type==='turret' 的夹具，
       反变换回**坦克局部坐标**（- angle）。顺序 = 夹具链表顺序。 */
    realTurret: function (pid) {
      var gc = GameManager.getGameController(), t = gc.getTank(pid);
      if (!t || !t.getB2DBody) return { err: 'no tank' };
      var b = t.getB2DBody(); if (!b) return { err: 'no body' };
      var pos = b.GetPosition(), ang = b.GetAngle();
      var ca = Math.cos(-ang), sa = Math.sin(-ang);
      var polys = [], fx = [];
      var f = b.GetFixtureList();
      while (f) {
        var ud = null; try { ud = f.GetUserData(); } catch (e) { ud = null; }
        var tp = ud ? ud.type : null; fx.push(tp);
        if (tp === 'turret') {
          // ⚠️ b2PolygonShape.m_vertices **本来就是 body 局部坐标**（工厂函数直接写进去的），
          //    不能再减体位置（那是重复变换；首版就栽在这，realTip 读成 27.7）。
          var sh = f.GetShape(), poly = [];
          for (var i = 0; i < sh.m_vertexCount; i++) {
            poly.push({ x: sh.m_vertices[i].x, y: sh.m_vertices[i].y });
          }
          polys.push(poly);
        }
        f = f.GetNext();
      }
      var w = null; try { w = gc.getActiveWeapon(pid); } catch (e2) { w = null; }
      return { polys: polys, fx: fx, type: w ? w.getType() : null,
               launched: (w && w.getField) ? !!w.getField('launched') : null,
               pos: { x: pos.x, y: pos.y }, ang: ang };
    },
    /* 沙箱判死轮廓（新代码的取法） */
    sbShape: function (pid) {
      var gc = GameManager.getGameController();
      return VantageSandbox.createAdapter(gc, pid).getTankShape();
    },
    /* 常量表（报告表用；含每种武器的出膛 OFFSET） */
    consts: function () {
      var C = Constants, m = function (v) { return (v && typeof v.m === 'number') ? v.m : null; };
      function one(T) {
        var o = { raw: {} };
        for (var k in T) { if (T.hasOwnProperty(k) && T[k] && typeof T[k] === 'object') o.raw[k] = m(T[k]); }
        return o;
      }
      return {
        WEAPON_TYPES: C.WEAPON_TYPES,
        OFFSET: {
          BULLET: m(C.BULLET.OFFSET), LASER: m(C.LASER.OFFSET), DOUBLE_BARREL: m(C.DOUBLE_BARREL.OFFSET),
          SHOTGUN: m(C.SHOTGUN.OFFSET), GATLING_GUN: m(C.GATLING_GUN.OFFSET),
          HOMING_MISSILE: m(C.HOMING_MISSILE.OFFSET), MINE: m(C.MINE.OFFSET)
        },
        RADIUS: {
          BULLET: m(C.BULLET.RADIUS), LASER: m(C.LASER.RADIUS), DOUBLE_BARREL: m(C.DOUBLE_BARREL.RADIUS),
          SHOTGUN: m(C.SHOTGUN.RADIUS), GATLING_GUN: m(C.GATLING_GUN.RADIUS),
          HOMING_MISSILE: m(C.HOMING_MISSILE.RADIUS), MINE: m(C.MINE.RADIUS)
        },
        TURRET: {
          BULLET: one(C.BULLET_TURRET), LASER: one(C.LASER_TURRET), DOUBLE_BARREL: one(C.DOUBLE_BARREL_TURRET),
          SHOTGUN: one(C.SHOTGUN_TURRET), MISSILE: one(C.MISSILE_TURRET), GATLING_GUN: one(C.GATLING_GUN_TURRET)
        }
      };
    },
    /* 找一个"车头正前方 2.80 m 开阔"的格心（rot=0），返回 {x,y,rot,bx,by} */
    findPose: function (graze) {
      var gc = GameManager.getGameController(), maze = gc.getMaze(), world = gc.getB2DWorld();
      var TILE = Constants.MAZE_TILE_SIZE.m, out = null;
      if (!maze || !world) return { err: 'no maze/world' };
      var w = maze.width, h = maze.height, bx, by, clearA, clearB;
      for (var i = 1; i < w - 1 && !out; i++) {
        for (var j = 2; j < h - 1 && !out; j++) {
          var x = i * TILE + TILE / 2, y = j * TILE + TILE / 2;
          bx = x; by = y - graze;
          try {
            clearA = B2DUtils.checkLineForMazeCollision(world,
              Box2D.Common.Math.b2Vec2.Make(x, y - 1.2), Box2D.Common.Math.b2Vec2.Make(bx, by - 0.4)) !== true;
            clearB = B2DUtils.checkLineForMazeCollision(world,
              Box2D.Common.Math.b2Vec2.Make(bx, by - 0.4), Box2D.Common.Math.b2Vec2.Make(bx, by + 0.4)) !== true;
          } catch (e) { clearA = false; clearB = false; }
          if (clearA && clearB) out = { x: x, y: y, rot: 0, bx: bx, by: by };
        }
      }
      return out || { err: 'no clear pose found' };
    },
    /* 真弹：owner=别人（⟹ 对受害者不是"自己的弹"，立刻致命） */
    spawnBullet: function (x, y, vx, vy, owner, type) {
      var rc = GameManager.getGameController().roundController;
      var id = IdGenerator.instance.gen('i4ab');
      rc.setProjectileState(ProjectileState.withState(id, owner, type, x, y, vx, vy));
      return id;
    },
    /* ③ 出膛点实测：调游戏自己的 pullTrigger（= _updateWeaponLockingAndFiring 每帧用的那个），
       **不 Step** 就读新弹位置 ⟹ 真正的出膛点；随后把新弹清掉（速度置 0 → stopped → done）。 */
    fireOnce: function (pid) {
      var gc = GameManager.getGameController(), rc = gc.roundController;
      var t = gc.getTank(pid); if (!t) return { err: 'no tank' };
      var tankPos = { x: t.getX(), y: t.getY(), rot: t.getRotation() };
      var w = null; try { w = gc.getActiveWeapon(pid); } catch (e) { w = null; }
      var before = {};
      var ps0 = (__vtData(gc.getRoundState()) || {}).projectileStates || [];
      for (var i = 0; i < ps0.length; i++) before[ps0[i].id] = 1;
      var ret = null, err = null;
      try { ret = rc.pullTrigger(pid); } catch (e2) { err = String(e2 && e2.message || e2); }
      var ps1 = (__vtData(gc.getRoundState()) || {}).projectileStates || [];
      var spawned = [];
      for (var j = 0; j < ps1.length; j++) {
        var ps = ps1[j];
        if (before[ps.id]) continue;
        spawned.push({ id: ps.id, type: ps.type, x: ps.x, y: ps.y,
                       d: Math.sqrt(Math.pow(ps.x - tankPos.x, 2) + Math.pow(ps.y - tankPos.y, 2)) });
      }
      // 清场：新弹速度置 0（Projectile.update 会 stopped → done() → 移除）
      for (var k = 0; k < spawned.length; k++) {
        try {
          rc.setProjectileState(ProjectileState.withState(spawned[k].id, pid, spawned[k].type,
            spawned[k].x, spawned[k].y, 0, 0));
        } catch (e3) { }
      }
      return { type: w ? w.getType() : null, fireRet: ret, err: err, tankPos: tankPos, spawned: spawned };
    },
    /* 探针清理：把场上所有弹挪到界外（900,900 在墙外，碰不到任何夹具） */
    nukeProjectiles: function () {
      var gc = GameManager.getGameController(), rc = gc.roundController;
      var d = __vtData(gc.getRoundState()) || {}, ps = d.projectileStates || [];
      var n = 0;
      for (var i = 0; i < ps.length; i++) {
        try {
          rc.setProjectileState(ProjectileState.withState(ps[i].id, ps[i].playerId, ps[i].type,
            900 + i, 900 + i, 0, 0));
          n++;
        } catch (e) { }
      }
      return n;
    },
    alive: function (pid) { return !!GameManager.getGameController().getTank(pid); },
    projCount: function () {
      var d = __vtData(GameManager.getGameController().getRoundState()) || {};
      return (d.projectileStates || []).length;
    }
  };
  return { ok: true };
})()`;

/* ---------------------------------------------------------------- 几何小工具 */
function tipOf(polys) {                 // 塔尖 = 局部坐标里最靠前（-y 最大）的顶点
  let tip = 2.0;                        // 无炮塔 → 车体半长
  for (const p of (polys || [])) for (const v of p) if (-v.y > tip) tip = -v.y;
  return tip;
}
function maxVertexDiff(a, b) {          // 两组多边形的最大顶点差（按"最近顶点"配对，兼容顺序不同）
  const flat = (ps) => [].concat(...(ps || []));
  const A = flat(a), B = flat(b);
  if (A.length !== B.length) return { n: [A.length, B.length], max: Infinity };
  let max = 0;
  for (const p of A) {
    let best = Infinity;
    for (const q of B) best = Math.min(best, Math.hypot(p.x - q.x, p.y - q.y));
    max = Math.max(max, best);
  }
  return { n: [A.length, B.length], max: max };
}

const WEAPONS = [
  { key: 'BULLET',         label: 'BULLET(默认)',   kind: null },
  { key: 'DOUBLE_BARREL',  label: 'DOUBLE_BARREL',  kind: 'DOUBLE_BARREL' },
  { key: 'SHOTGUN',        label: 'SHOTGUN',        kind: 'SHOTGUN' },
  { key: 'GATLING_GUN',    label: 'GATLING_GUN',    kind: 'GATLING' },
  { key: 'LASER',          label: 'LASER',          kind: 'LASER' },
  { key: 'HOMING_MISSILE', label: 'HOMING_MISSILE', kind: 'HOMING' },
  { key: 'MINE',           label: 'MINE',           kind: 'MINE' }
];

(async () => {
  const res = { startedAt: new Date().toISOString(), graze: GRAZE, rows: [], realGame: [], errors: [] };
  const m = new Match();
  try {
    await m.open({ humanIds: ['tank_a', 'tank_b', 'tank_c'], aiCount: 0, vantCount: 0 });
    await m.clearControl();
    await m.eval(INSTALL);

    res.constants = await m.eval('window.__i4a.consts()');
    const pose = await m.eval(`window.__i4a.findPose(${GRAZE})`);
    res.pose = pose;
    if (pose.err) throw new Error('findPose: ' + pose.err);

    // 受害坦克 tank_a 摆到"车头朝 -y、前方 2.80 m 开阔"的格心；另两辆挪远（别挡弹）
    await m.teleport('tank_a', pose.x, pose.y, 0);
    await m.teleport('tank_c', 5, 5, 0).catch(() => {});
    await m.teleport('tank_b', 65, 45, 0).catch(() => {});

    // 远离测试位的三个停车位（tank_a/b/c 各一个）
    const FAR = { tank_a: [5, 5], tank_b: [65, 45], tank_c: [5, 45] };

    /* ---- ① 逐武器：真夹具 vs 沙箱轮廓 vs 新旧判死 ------------------------ */
    for (const W of WEAPONS) {
      const row = { weapon: W.label, key: W.key };
      if (W.kind) row.inject = await m.eval(`window.__i4a.inject(${JSON.stringify(W.kind)}, 'tank_a')`);
      else row.inject = { note: '默认武器（不注入）' };
      row.realTurret = await m.eval(`window.__i4a.realTurret('tank_a')`);
      row.sbShape = await m.eval(`window.__i4a.sbShape('tank_a')`);

      const bullet = { x: pose.x, y: pose.y - GRAZE };
      const sb = await m.eval(`(() => {
        var gc = GameManager.getGameController();
        var ad = VantageSandbox.createAdapter(gc, 'tank_a');
        var p = { x: ${pose.x}, y: ${pose.y}, rot: 0 };
        var b = [{ x: ${bullet.x}, y: ${bullet.y} }];
        var legacy = VantageSandbox.legacyTurretShape(ad.constants);
        return {
          newDead: ad.checkDeath(p, b),
          oldDead: ad.checkDeath(p, b, legacy),
          sweepNew: ad.checkDeathSweep(p, [{ ax: ${bullet.x - 0.5}, ay: ${bullet.y}, bx: ${bullet.x + 0.5}, by: ${bullet.y} }]),
          sweepOld: ad.checkDeathSweep(p, [{ ax: ${bullet.x - 0.5}, ay: ${bullet.y}, bx: ${bullet.x + 0.5}, by: ${bullet.y} }], legacy),
          sweepNew60: ad.checkDeathSweep(p, [{ ax: ${bullet.x - 0.5}, ay: ${pose.y - 2.60}, bx: ${bullet.x + 0.5}, by: ${pose.y - 2.60} }]),
          sweepOld60: ad.checkDeathSweep(p, [{ ax: ${bullet.x - 0.5}, ay: ${pose.y - 2.60}, bx: ${bullet.x + 0.5}, by: ${pose.y - 2.60} }], legacy),
          sig: ad.getTankShape().sig
        };
      })()`);
      Object.assign(row, sb);
      row.realTip = tipOf(row.realTurret.polys);
      row.sbTip = row.sbShape.tip;
      row.oldTip = 2.7;                                       // 旧代码写死的炮弹炮塔塔尖
      row.vertexDiff = maxVertexDiff(row.realTurret.polys, row.sbShape.polys);
      row.realTurretType = row.realTurret.type;
      row.realTurretCount = row.realTurret.polys.length;
      row.sandboxPolyCount = row.sbShape.polys.length;
      row.fusedLocalPolys = await m.eval(`(() => {
        var gc = GameManager.getGameController();
        var ad = VantageSandbox.createAdapter(gc, 'tank_a');
        var ps = ad.getFusedCandidateLocalPolys(0) || [];
        return ps.map(function (x) { return { type: x.type, n: x.verts.length }; });
      })()`);
      res.rows.push(row);
      console.log(JSON.stringify({
        w: row.weapon, type: row.realTurretType, sig: row.sig,
        realTip: +row.realTip.toFixed(4), sbTip: +row.sbTip.toFixed(4), oldTip: row.oldTip,
        realFx: row.realTurretCount, sbPoly: row.sandboxPolyCount,
        vdiff: (row.vertexDiff.max === Infinity ? 'INF' : row.vertexDiff.max.toExponential(2)),
        newDead: row.newDead, oldDead: row.oldDead,
        sweep260: row.sweepNew60, sweep260old: row.sweepOld60,
        activeType: row.inject ? row.inject.activeType : null,
        activeTurretFx: row.inject ? row.inject.turretFx : null
      }));
    }

    /* ---- ③ 出膛点 vs 该武器炮塔：「加特林不在塔内、其余在塔内」 -------------
     *   出膛偏移 = Constants.<W>.OFFSET.m，并尽量用 `pullTrigger` **实测**核对；
     *   判据 = 出膛点是否落在**沙箱当前的**炮塔轮廓里（用沙箱自己的 checkDeath 判，
     *   ⟹ 这一行就是"0 帧自杀"在沙箱里的等价判据）。
     *   全部用 **tank_b**（它在这场里从不当受害者，能一直用；默认弹那一行不注入
     *   ⟹ active 天然是默认弹）。开火前/后各读一次轮廓，顺带测出
     *   "导弹发射后炮管消失"（`:launched`）那条分支。加特林 `fire()` 要充能 ⟹
     *   打不出弹（与上一轮审计同一限制），那一行只有常量口径。 */
    res.muzzle = [];
    for (const W of WEAPONS) {
      const pid = 'tank_b';
      await m.eval(`window.__i4a.nukeProjectiles()`);
      await m.teleport(pid, pose.x, pose.y, 0);
      for (const q of ['tank_a', 'tank_c']) await m.teleport(q, FAR[q][0], FAR[q][1], 0).catch(() => { });
      let inj = null;
      if (W.kind !== null) inj = await m.eval(`window.__i4a.inject(${JSON.stringify(W.kind)}, ${JSON.stringify(pid)})`);
      const active = await m.eval(`(() => { var w = null; try { w = GameManager.getGameController().getActiveWeapon(${JSON.stringify(pid)}); } catch (e) {} return w ? w.getType() : null; })()`);
      const offsetConst = res.constants.OFFSET[W.key];
      const radiusConst = res.constants.RADIUS[W.key];
      const pre = await m.eval(`(() => {
        var gc = GameManager.getGameController();
        var ad = VantageSandbox.createAdapter(gc, ${JSON.stringify(pid)});
        var sh = ad.getTankShape();
        return { tip: sh.tip, sig: sh.sig, polys: sh.polys.length, name: sh.name,
                 launched: sh.launched, polysFull: sh.polys };
      })()`);
      // 出膛点是否落在炮塔里 —— **必须用开火前**的轮廓（开火后导弹那个分支会把炮管拆掉；
      // 首版把这一步放在开火之后 ⟹ 导弹行读成 false，是"顺序"而不是"产品"的问题）。
      async function selfDeadAt(dd) {
        if (!(dd > 0)) return null;
        return m.eval(`(() => {
          var gc = GameManager.getGameController();
          var ad = VantageSandbox.createAdapter(gc, ${JSON.stringify(pid)});
          var sh = { name: ${JSON.stringify(pre.name)}, launched: ${!!pre.launched},
                     polys: ${JSON.stringify(pre.polysFull)} };
          return ad.checkDeath({ x: ${pose.x}, y: ${pose.y}, rot: 0 },
                               [{ x: ${pose.x}, y: ${pose.y} - ${dd} }], sh);
        })()`);
      }
      const selfDeadConst = await selfDeadAt(offsetConst);
      const fire = await m.eval(`window.__i4a.fireOnce(${JSON.stringify(pid)})`);
      const post = await m.eval(`(() => {
        var gc = GameManager.getGameController();
        var ad = VantageSandbox.createAdapter(gc, ${JSON.stringify(pid)});
        var sh = ad.getTankShape();
        return { tip: sh.tip, sig: sh.sig, polys: sh.polys.length };
      })()`);
      const measured = (fire.spawned && fire.spawned.length === 1) ? fire.spawned[0].d : null;
      const d = measured !== null ? measured : offsetConst;
      const row = {
        weapon: W.label, key: W.key, pid,
        activeType: active, injectedType: inj ? inj.type : null,
        offsetConst, radiusConst, fireRet: fire.fireRet, fireErr: fire.err,
        measuredSpawnD: measured, spawnSrc: measured !== null ? 'pullTrigger 实测' : 'Constants.OFFSET',
        spawnDUsed: d,
        preTip: pre.tip, preSig: pre.sig, prePolyCount: pre.polys,
        postTip: post.tip, postSig: post.sig, postPolyCount: post.polys,
        centerInsideTurret: (d !== null && d > 0) ? (d < pre.tip) : null,
        sandboxSelfDeadConst: selfDeadConst,
        sandboxSelfDead: null
      };
      // 用**实测**出膛点再算一次（同一个开火前轮廓）；只有真打得出弹的武器才有这一项
      if (measured !== null) row.sandboxSelfDead = await selfDeadAt(measured);
      res.muzzle.push(row);
      console.log('MUZZLE ' + JSON.stringify(row));
    }

    /* ---- ④ 真游戏自己判：同一局面、同样的弹，三种武器 --------------------
     *   顺序很关键：先测"应该活"的（坦克不死），最后才测"应该死"的。
     *   ⚠️ 每次 trial 前先把场上所有弹挪到界外（上一发的残留会污染下一发）。 */
    async function gameTrial(victim, owner, kind, expect) {
      await m.eval(`window.__i4a.nukeProjectiles()`);
      for (const pid of Object.keys(FAR)) {
        await m.teleport(pid, FAR[pid][0], FAR[pid][1], 0).catch(() => { });
      }
      const inj = await m.eval(`window.__i4a.inject(${JSON.stringify(kind)}, ${JSON.stringify(victim)})`);
      await m.teleport(victim, pose.x, pose.y, 0);
      const rt = await m.eval(`window.__i4a.realTurret(${JSON.stringify(victim)})`);
      const projBefore = await m.eval(`window.__i4a.projCount()`);
      await m.eval(`window.__i4a.spawnBullet(${pose.x}, ${pose.y - GRAZE}, 1.0, 0, ${JSON.stringify(owner)}, ${-1})`);
      let dead = -1;
      for (let i = 0; i < 20; i++) {
        await m.pump(1, { yieldMs: 0 });
        const alive = await m.eval(`window.__i4a.alive(${JSON.stringify(victim)})`);
        if (!alive) { dead = i; break; }
      }
      const out = {
        victim, owner, kind, expect, inj,
        activeType: inj.activeType, turretFx: inj.turretFx, projBefore,
        realTip: tipOf(rt.polys), realPolys: rt.polys.length,
        died: dead >= 0, deathFrame: dead, deadAtSec: dead >= 0 ? +(dead * DT).toFixed(3) : null,
        verdict: (expect === 'live') === (dead < 0) ? 'PASS' : 'FAIL'
      };
      res.realGame.push(out);
      console.log('REAL-GAME ' + JSON.stringify(out));
      return out;
    }

    const t1 = await gameTrial('tank_a', 'tank_b', 'DOUBLE_BARREL', 'live');
    const t2 = (t1.died) ? null : await gameTrial('tank_c', 'tank_b', 'MINE', 'live');
    const t3 = (t2 && !t2.died) ? await gameTrial('tank_b', 'tank_a', 'SHOTGUN', 'dead') : null;
    res.realGameSummary = { doubleBarrel: t1, mine: t2, shotgun: t3 };
  } catch (e) {
    res.errors.push(String((e && e.stack) || e));
  } finally {
    try { await m.close(); } catch (e) { }
  }
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, '_i4a_shape_sig.json'), JSON.stringify(res, null, 1));
  console.log('WROTE ' + path.join(OUT, '_i4a_shape_sig.json'));
  console.log('ERRORS ' + JSON.stringify(res.errors));
  process.exitCode = res.errors.length ? 1 : 0;
})();
