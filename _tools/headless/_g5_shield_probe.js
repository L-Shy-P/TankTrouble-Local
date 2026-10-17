#!/usr/bin/env node
'use strict';
/* ============================================================================
 * G5（§12.8 / §12.31）护盾 fixture 进融合世界 —— 自证探针
 *
 * 证据清单（全部真对局）：
 *   A. 三态：① 外来弹撞盾 → **反弹** ② 破片撞盾 → **停** ③ 自己的（还没致命的）弹 → **穿过**
 *   B. 斜打对拍：**用接触前一帧位置**算的镜面反射预测误差 < 0.2 m/s；用反弹后那帧算 ≈1.2（口径对照）
 *   C. §12.31A 的两条：① 贴墙射击 → 自己弹反弹回来自杀 ② 脚边雷爆
 *   D. 假阳率：**沙箱说"有盾" ⟺ 真坦克 body 上真有 SHIELD 夹具**（逐帧对照：FP/FN 计数）
 *   E. 护盾寿命：`SHIELD_LIFETIME=6.0`（源码）vs 实测夹具消失帧数（§五 要核清的那条）
 *
 * 只读产品代码；只写 `_tools/headless/_g5_prof/`。
 * 用法：node _tools/headless/_g5_shield_probe.js
 * ============================================================================ */
const fs = require('fs');
const path = require('path');
const { Match } = require('./match');

const OUT = path.join(__dirname, '_g5_prof');
const GRAZE = 2.80;

const INSTALL = `(() => {
  window.__g5 = {
    gc: function () { return GameManager.getGameController(); },
    ad: function (pid) { return VantageSandbox.createAdapter(GameManager.getGameController(), pid || 'tank_a'); },
    /* 车头正前方开阔的格心（rot=0，车头朝 -y） */
    findPose: function (graze) {
      var gc = GameManager.getGameController(), maze = gc.getMaze(), world = gc.getB2DWorld();
      var TILE = Constants.MAZE_TILE_SIZE.m, out = null;
      for (var i = 1; i < maze.width - 1 && !out; i++) for (var j = 2; j < maze.height - 1 && !out; j++) {
        var x = i * TILE + TILE / 2, y = j * TILE + TILE / 2, bx = x, by = y - graze;
        var cA = false, cB = false;
        try {
          cA = B2DUtils.checkLineForMazeCollision(world, Box2D.Common.Math.b2Vec2.Make(x, y - 1.2),
                Box2D.Common.Math.b2Vec2.Make(bx, by - 0.4)) !== true;
          cB = B2DUtils.checkLineForMazeCollision(world, Box2D.Common.Math.b2Vec2.Make(bx, by - 0.4),
                Box2D.Common.Math.b2Vec2.Make(bx, by + 0.4)) !== true;
        } catch (e) { cA = false; cB = false; }
        if (cA && cB) out = { x: x, y: y, rot: 0, bx: bx, by: by };
      }
      return out || { err: 'no clear pose' };
    },
    /* 正前方 2.5~4.0 m 内有墙的格心（贴墙自杀用） */
    findWallPose: function () {
      var gc = GameManager.getGameController(), maze = gc.getMaze(), world = gc.getB2DWorld();
      var TILE = Constants.MAZE_TILE_SIZE.m, out = null;
      for (var i = 1; i < maze.width - 1 && !out; i++) for (var j = 2; j < maze.height - 1 && !out; j++) {
        var x = i * TILE + TILE / 2, y = j * TILE + TILE / 2;
        var hit = false;
        try { hit = B2DUtils.checkLineForMazeCollision(world, Box2D.Common.Math.b2Vec2.Make(x, y - 2.4),
                Box2D.Common.Math.b2Vec2.Make(x, y - 4.2)) === true; } catch (e) { hit = false; }
        if (hit) out = { x: x, y: y, rot: 0 };
      }
      return out || { err: 'no wall pose' };
    },
    spawnProj: function (x, y, vx, vy, owner, type) {
      var rc = GameManager.getGameController().roundController;
      var id = IdGenerator.instance.gen('g5p');
      rc.setProjectileState(ProjectileState.withState(id, owner, type, x, y, vx, vy));
      return id;
    },
    proj: function (id) {
      var gc = GameManager.getGameController(), p = gc.getProjectile ? gc.getProjectile(id) : null;
      if (!p) return null;
      var b = p.getB2DBody(), pos = b.GetPosition(), v = b.GetLinearVelocity();
      return { id: id, type: p.getType ? p.getType() : null, owner: p.getPlayerId ? p.getPlayerId() : null,
               x: pos.x, y: pos.y, vx: v.x, vy: v.y, speed: Math.sqrt(v.x * v.x + v.y * v.y),
               age: p.getTimeAlive ? p.getTimeAlive() : null, done: p.done ? !!p.done() : null,
               deadlyToOwner: p.isDeadlyToOwner ? !!p.isDeadlyToOwner() : null };
    },
    tankPose: function (pid) {
      var t = GameManager.getGameController().getTank(pid);
      return t ? { x: t.getX(), y: t.getY(), rot: t.getRotation() } : null;
    },
    alive: function (pid) { return !!GameManager.getGameController().getTank(pid); },
    /* 给坦克发一块护盾（走游戏自己的 Upgrade 入口） */
    grantShield: function (pid) {
      var gc = GameManager.getGameController();
      var st = ShieldUpgrade.createInitialUpgradeState(IdGenerator.instance.gen('g5u'), pid);
      gc.roundController.setUpgradeState(st);
      return st.getId();
    },
    /* 真坦克 body 上的 SHIELD 夹具（ground truth；工厂 userData.type = upgrade.getType() = 2） */
    realShield: function (pid) {
      var gc = GameManager.getGameController(), t = gc.getTank(pid);
      if (!t || !t.getB2DBody()) return { has: false, err: 'no tank' };
      var want = (Constants.UPGRADE_TYPES && Constants.UPGRADE_TYPES.SHIELD !== undefined)
        ? Constants.UPGRADE_TYPES.SHIELD : 2;
      var f = t.getB2DBody().GetFixtureList(), out = { has: false };
      while (f) {
        var u = null; try { u = f.GetUserData(); } catch (e) {}
        if (u && u.type === want) {
          var sh = f.GetShape(), fd = f.GetFilterData();
          out = { has: true, r: sh.m_radius, categoryBits: fd.categoryBits, maskBits: fd.maskBits,
                  maskHasMaze: !!(fd.maskBits & Constants.COLLISION_CATEGORIES.MAZE) };
        }
        f = f.GetNext();
      }
      return out;
    },
    upgradeLife: function (pid) {
      var gc = GameManager.getGameController();
      var T = (Constants.UPGRADE_TYPES && Constants.UPGRADE_TYPES.SHIELD !== undefined) ? Constants.UPGRADE_TYPES.SHIELD : 2;
      var u = null; try { u = gc.getUpgradeByPlayerIdAndType(pid, T); } catch (e) {}
      if (!u) return null;
      return { id: u.getId ? u.getId() : null, life: (u.getField ? u.getField('lifetime') : null),
               weakened: (u.getField ? !!u.getField('weakened') : null) };
    },
    /* 沙箱侧的盾（候选体 op0）+ 本轮的 PreSolve 规则判定 */
    sbShield: function (pid) {
      var ad = window.__g5.ad(pid);
      var sh = ad.getFusedCandidateShield(0);
      var st = ad.getFusedShieldStats();
      return { fixture: sh, stats: { built: st.built, torn: st.torn, bounceContacts: st.bounceContacts,
               shrapnelStops: st.shrapnelStops, ownPassThrough: st.ownPassThrough,
               hasShieldFixture: st.hasShieldFixture, roundSlots: st.roundSlots } };
    },
    gameConsts: function () {
      return { SHIELD_LIFETIME: Constants.SHIELD_LIFETIME,
               SPAWN_SHIELD_LIFETIME: Constants.SPAWN_SHIELD_LIFETIME,
               SHIELD_RADIUS_M: Constants.SHIELD.RADIUS.m,
               UPGRADE_TYPES: Constants.UPGRADE_TYPES,
               FRAME_DT_SANDBOX: VantageSandbox.getFrameDtSec ? VantageSandbox.getFrameDtSec() : null };
    }
  };
  return { ok: true };
})()`;

(async () => {
  const res = { startedAt: new Date().toISOString(), steps: [], samples: [], errors: [] };
  const m = new Match();
  const add = (name, obj) => { const s = Object.assign({ name: name }, obj); res.steps.push(s); console.log(name + ' ' + JSON.stringify(s)); return s; };
  try {
    await m.open({ humanIds: ['tank_a', 'tank_b', 'tank_c'], aiCount: 0, vantCount: 0 });
    await m.clearControl();
    await m.eval(INSTALL);
    res.consts = await m.eval('window.__g5.gameConsts()');
    res.pose = await m.eval(`window.__g5.findPose(${GRAZE})`);
    res.wallPose = await m.eval('window.__g5.findWallPose()');
    if (res.pose.err) throw new Error('findPose: ' + res.pose.err);
    const P = res.pose;
    for (const t of [['tank_a', P.x, P.y, 0], ['tank_b', 65, 45, 0], ['tank_c', 5, 45, 0]]) {
      await m.teleport(t[0], t[1], t[2], t[3]).catch(() => { });
    }

    /* ---------- D+E. 护盾夹具出现 → 逐帧对照（假阳率）→ 到期消失 ---------- */
    const upId = await m.eval(`window.__g5.grantShield('tank_a')`);
    await m.pump(2, { yieldMs: 0 });
    const real0 = await m.eval(`window.__g5.realShield('tank_a')`);
    const sb0 = await m.eval(`window.__g5.sbShield('tank_a')`);
    add('D0_shield_built', { upgradeId: upId, real: real0, sandbox: sb0.fixture, stats: sb0.stats });

    let agreed = { tp: 0, fp: 0, tn: 0, fn: 0, n: 0 };
    let lifeFrames = 0, lifeLostAt = null, lifeAtLoss = null;
    for (let f = 0; f < 420; f++) {
      await m.pump(1, { yieldMs: 0 });
      if (f % 10 === 0 || f > 300) {
        const r = await m.eval(`(() => { var gc = GameManager.getGameController();
          var ad = VantageSandbox.createAdapter(gc, 'tank_a');
          return { real: window.__g5.realShield('tank_a').has, sb: !!ad.getFusedCandidateShield(0).has,
                   life: window.__g5.upgradeLife('tank_a') }; })()`);
        agreed.n++;
        if (r.real && r.sb) agreed.tp++;
        else if (!r.real && r.sb) agreed.fp++;
        else if (!r.real && !r.sb) agreed.tn++;
        else agreed.fn++;
        if (lifeLostAt === null && !r.real) { lifeLostAt = f; lifeAtLoss = r.life; lifeFrames = f; }
      }
      if (lifeLostAt !== null && f > lifeLostAt + 10) break;
    }
    add('E_lifetime', { grantFrame: 0, fixtureGoneAtFrame: lifeLostAt, upgradeAtLoss: lifeAtLoss,
      realFramesAt60fps: lifeLostAt !== null ? +(lifeLostAt / 60).toFixed(3) : null,
      sandboxFrameDt: res.consts.FRAME_DT_SANDBOX, consts: { SHIELD_LIFETIME: res.consts.SHIELD_LIFETIME,
        SPAWN_SHIELD_LIFETIME: res.consts.SPAWN_SHIELD_LIFETIME } });
    add('D1_fp_rate', agreed);

    /* ---------- A. 三态（重新发一块盾） ---------- */
    await m.teleport('tank_a', P.x, P.y, 0);
    await m.eval(`window.__g5.grantShield('tank_a')`);
    await m.pump(2, { yieldMs: 0 });
    const realA = await m.eval(`window.__g5.realShield('tank_a')`);
    const sbA = await m.eval(`window.__g5.sbShield('tank_a')`);
    add('A0_shield_again', { real: realA, sbFixture: sbA.fixture, built: sbA.stats.built, torn: sbA.stats.torn });

    // ① 外来弹撞盾 → 反弹
    const b1 = await m.eval(`window.__g5.spawnProj(${P.x}, ${P.y - 9.0}, 0, 6.0, 'tank_b', ${-1})`);
    let before1 = null, after1 = null, bounceFrame = -1;
    for (let f = 0; f < 90; f++) {
      await m.pump(1, { yieldMs: 0 });
      const st = await m.eval(`window.__g5.proj(${JSON.stringify(b1)})`);
      if (!st) break;
      if (before1 === null) before1 = st;
      if (bounceFrame < 0 && st.vy < 0) { bounceFrame = f; after1 = st; }
      if (bounceFrame >= 0 && f > bounceFrame + 3) break;
    }
    const sbAfterBounce = await m.eval(`window.__g5.sbShield('tank_a')`);
    add('A1_bounce', { bullet: b1, before: before1 && { y: before1.y, vy: before1.vy, speed: before1.speed },
      after: after1 && { y: after1.y, vy: after1.vy, speed: after1.speed }, bounceFrame: bounceFrame,
      speedPreserved: (before1 && after1) ? +(after1.speed / before1.speed).toFixed(4) : null,
      sandboxBounceContacts: sbAfterBounce.stats.bounceContacts, slotRule: sbAfterBounce.stats.roundSlots });

    // ③ 自己的（还没致命的）弹 → 穿过
    const b2 = await m.eval(`window.__g5.spawnProj(${P.x}, ${P.y - 1.0}, 0, -6.0, 'tank_a', ${-1})`);
    const t0 = await m.eval(`window.__g5.tankPose('tank_a')`);
    let dStart = null, dEnd = null, vConst = true, crossed = false;
    for (let f = 0; f < 50; f++) {
      await m.pump(1, { yieldMs: 0 });
      const st = await m.eval(`window.__g5.proj(${JSON.stringify(b2)})`);
      if (!st) break;
      const d = Math.hypot(st.x - t0.x, st.y - t0.y);
      if (dStart === null) dStart = d;
      dEnd = d;
      if (Math.abs(st.vy - (-6.0)) > 0.01) vConst = false;
      if (d > realA.r + 0.3) crossed = true;
      if (crossed && f > 5) break;
    }
    const sbOwn = await m.eval(`window.__g5.sbShield('tank_a')`);
    add('A3_own_pass_through', { bullet: b2, shieldR: realA.r, dStart: dStart && +dStart.toFixed(3),
      dEnd: dEnd && +dEnd.toFixed(3), crossedShieldSurface: crossed, vyUnchanged: vConst,
      sandboxOwnPassThrough: sbOwn.stats.ownPassThrough, slotRule: sbOwn.stats.roundSlots,
      rule: (sbOwn.stats.roundSlots && sbOwn.stats.roundSlots[0]) ? sbOwn.stats.roundSlots[0].rule : null });

    // ② 破片撞盾 → 停
    const b3 = await m.eval(`window.__g5.spawnProj(${P.x}, ${P.y - 9.0}, 0, 18.0, 'tank_b', ${4})`).catch(() => null);
    res.steps.push({ name: 'note', msg: 'shrapnel 用 type=MINE(4)' });
    const mineType = 4;
    const b3b = await m.eval(`window.__g5.spawnProj(${P.x}, ${P.y - 9.0}, 0, 18.0, 'tank_b', ${mineType})`);
    let shrBefore = null, shrAfter = null, shrGone = false, shrStopFrame = -1;
    for (let f = 0; f < 60; f++) {
      await m.pump(1, { yieldMs: 0 });
      const st = await m.eval(`window.__g5.proj(${JSON.stringify(b3b)})`);
      if (!st) { shrGone = true; if (shrStopFrame < 0) shrStopFrame = f; break; }
      if (shrBefore === null) shrBefore = st;
      if (st.speed < 0.5 && shrAfter === null) { shrAfter = st; shrStopFrame = f; }
      shrAfter = st;
      if (shrAfter && shrAfter.speed < 0.5 && f > shrStopFrame + 2) break;
    }
    const sbShr = await m.eval(`window.__g5.sbShield('tank_a')`);
    add('A2_shrapnel_stop', { bullet: b3b, before: shrBefore && { y: shrBefore.y, speed: shrBefore.speed },
      after: shrAfter && { y: shrAfter.y, speed: shrAfter.speed }, stoppedAtFrame: shrStopFrame,
      gone: shrGone, sandboxShrapnelStops: sbShr.stats.shrapnelStops, slotRule: sbShr.stats.roundSlots });

    /* ---------- B. 斜打对拍（镜面反射 + 口径对照） ---------- */
    await m.eval(`window.__i4x0 = 1`);
    const b4 = await m.eval(`window.__g5.spawnProj(${P.x - 7.0}, ${P.y - 9.0}, 6.0, 6.0, 'tank_b', ${-1})`);
    let prev = null, hitPrev = null, hitNext = null, hitFrame = -1;
    for (let f = 0; f < 90; f++) {
      await m.pump(1, { yieldMs: 0 });
      const st = await m.eval(`window.__g5.proj(${JSON.stringify(b4)})`);
      if (!st) break;
      if (prev && ((st.vx !== prev.vx) || (st.vy !== prev.vy))) { hitPrev = prev; hitNext = st; hitFrame = f; break; }
      prev = st;
    }
    if (hitPrev && hitNext) {
      const t0b = await m.eval(`window.__g5.tankPose('tank_a')`);
      const mirror = (p) => {                        // 关于连心线法线的镜面反射
        const nx0 = p.x - t0b.x, ny0 = p.y - t0b.y, L = Math.hypot(nx0, ny0);
        const nx = nx0 / L, ny = ny0 / L;
        const dot = hitPrev.vx * nx + hitPrev.vy * ny;
        return { vx: hitPrev.vx - 2 * dot * nx, vy: hitPrev.vy - 2 * dot * ny };
      };
      const predPrev = mirror(hitPrev);
      const predNext = mirror(hitNext);
      const e1 = Math.hypot(predPrev.vx - hitNext.vx, predPrev.vy - hitNext.vy);
      const e2 = Math.hypot(predNext.vx - hitNext.vx, predNext.vy - hitNext.vy);
      add('B_oblique_mirror', { bullet: b4, hitFrame: hitFrame,
        v_before: { x: hitPrev.vx, y: hitPrev.vy }, v_after: { x: +hitNext.vx.toFixed(6), y: +hitNext.vy.toFixed(6) },
        speedBefore: +hitPrev.speed.toFixed(6), speedAfter: +hitNext.speed.toFixed(6),
        predFromPrevFrame: { x: +predPrev.vx.toFixed(4), y: +predPrev.vy.toFixed(4) },
        predFromAfterFrame: { x: +predNext.vx.toFixed(4), y: +predNext.vy.toFixed(4) },
        errPrevFrame: +e1.toFixed(4), errAfterFrame: +e2.toFixed(4),
        pass_lt_0_2: e1 < 0.2 });
    } else {
      add('B_oblique_mirror', { err: 'no bounce observed', bullet: b4 });
    }

    /* ---------- C1. 贴墙射击 → 自己弹反弹回来自杀 ---------- */
    const W = res.wallPose;
    if (!W.err) {
      await m.teleport('tank_a', W.x, W.y, 0);
      await m.pump(2, { yieldMs: 0 });
      const hasShield = (await m.eval(`window.__g5.realShield('tank_a')`)).has;
      const b5 = await m.eval(`window.__g5.spawnProj(${W.x}, ${W.y - 2.5}, 0, -18.0, 'tank_a', ${-1})`);
      let died = -1;
      for (let f = 0; f < 60; f++) {
        await m.pump(1, { yieldMs: 0 });
        if (!(await m.eval(`window.__g5.alive('tank_a')`))) { died = f; break; }
      }
      add('C1_wall_suicide', { wallPose: W, hadShield: hasShield, bullet: b5,
        died: died >= 0, deathFrame: died });
    }

    /* ---------- C2. 脚边雷爆（破片生成在坦克体内） ---------- */
    const alive = await m.eval(`window.__g5.alive('tank_a')`);
    if (alive) {
      const tp = await m.eval(`window.__g5.tankPose('tank_a')`);
      const s1 = await m.eval(`window.__g5.spawnProj(${tp.x}, ${tp.y}, 0.2, 0.2, 'tank_b', ${mineType})`);
      let died2 = -1;
      for (let f = 0; f < 20; f++) {
        await m.pump(1, { yieldMs: 0 });
        if (!(await m.eval(`window.__g5.alive('tank_a')`))) { died2 = f; break; }
      }
      add('C2_mine_at_feet', { shrapnel: s1, shrapnelAt: tp, hadShield: true,
        died: died2 >= 0, deathFrame: died2 });
    } else {
      add('C2_mine_at_feet', { skipped: 'tank_a already dead from C1' });
    }
  } catch (e) {
    res.errors.push(String((e && e.stack) || e));
  } finally {
    try { await m.close(); } catch (e) { }
  }
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, '_g5_shield.json'), JSON.stringify(res, null, 1));
  console.log('WROTE ' + path.join(OUT, '_g5_shield.json'));
  console.log('ERRORS ' + JSON.stringify(res.errors));
  process.exitCode = res.errors.length ? 1 : 0;
})();
