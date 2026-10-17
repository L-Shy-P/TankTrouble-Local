#!/usr/bin/env node
'use strict';
/* ============================================================================
 * G5 收尾探针（**只修探针，不动产品代码**）
 *   B 斜打镜面反射对拍（**保证斜向路径不撞墙 + 命中点确实在盾面上**；两个口径都报）
 *   C1 贴墙自杀（findWallPose 搜索带修正：按 maze.getTiles() 找邻墙格，坦克贴到离墙 2.7 m）
 *   F  假阳率**全象限**（带盾 tank_a / 裸 tank_c）+ **SPAWN_SHIELD 混淆项**
 *   E  护盾寿命复测（帧号 + dt + 与 6.0 s 的关系；不假设，先测每帧寿命减多少）
 * 用法：node _tools/headless/_g5_fix_probe.js
 * ============================================================================ */
const fs = require('fs'), path = require('path');
const { Match } = require('./match');
const OUT = path.join(__dirname, '_g5_prof');
const TILE_KEYS = null;

const INSTALL = `(() => { window.__f = {
  gc: function () { return GameManager.getGameController(); },
  ad: function (pid) { return VantageSandbox.createAdapter(GameManager.getGameController(), pid); },
  pose: function (pid) { var t = GameManager.getGameController().getTank(pid); return t ? { x: t.getX(), y: t.getY(), rot: t.getRotation() } : null; },
  /* 开阔格心（车头正前方 2.8 m 净空） */
  findPose: function () { var gc = GameManager.getGameController(), maze = gc.getMaze(), world = gc.getB2DWorld();
    var T = Constants.MAZE_TILE_SIZE.m, out = null;
    for (var i = 1; i < maze.width - 1 && !out; i++) for (var j = 2; j < maze.height - 1 && !out; j++) {
      var x = i * T + T / 2, y = j * T + T / 2, cA = false, cB = false;
      try { cA = B2DUtils.checkLineForMazeCollision(world, Box2D.Common.Math.b2Vec2.Make(x, y - 1.2), Box2D.Common.Math.b2Vec2.Make(x, y - 2.4)) !== true;
            cB = B2DUtils.checkLineForMazeCollision(world, Box2D.Common.Math.b2Vec2.Make(x, y - 2.4), Box2D.Common.Math.b2Vec2.Make(x, y - 3.6)) !== true; } catch (e) {}
      if (cA && cB) out = { x: x, y: y, rot: 0 }; }
    return out; },
  /* ★ 修正版：按 tiles 找"下方的墙"（tiles[i][j][1] = 该格 -y 边有墙），坦克贴到离墙 2.7 m */
  findWallPose: function () { var gc = GameManager.getGameController(), maze = gc.getMaze();
    var T = Constants.MAZE_TILE_SIZE.m, tiles = maze.getTiles();
    for (var i = 1; i < maze.width - 1; i++) for (var j = 1; j < maze.height; j++) {
      var t = tiles[i] && tiles[i][j];
      if (!t || t[1] !== 1) continue;                 // 该格 -y 边有墙
      var x = i * T + T / 2, y = j * T + 2.7;         // 坦克心距墙面 2.7 m（车头朝 -y）
      return { x: x, y: y, rot: 0, wallDist: 2.7, tile: [i, j] };
    }
    return { err: 'no wall tile' }; },
  /* 斜打发射点：绕坦克心 6 m 的弧上找一条**到坦克心整条线都不撞墙**的点（= 保证命中点在盾面） */
  findOblique: function (pid, deg) {
    var gc = GameManager.getGameController(), world = gc.getB2DWorld(), t = gc.getTank(pid);
    if (!t) return { err: 'no tank' };
    var cx = t.getX(), cy = t.getY();
    for (var s = 0; s < 2; s++) {
      var d = (s ? -1 : 1) * deg * Math.PI / 180.0, R = 6.0;
      var x = cx + Math.sin(d) * R, y = cy - Math.cos(d) * R;   // rot=0 时车头 = -y
      var clear = false;
      try { clear = B2DUtils.checkLineForMazeCollision(world,
              Box2D.Common.Math.b2Vec2.Make(x, y), Box2D.Common.Math.b2Vec2.Make(cx, cy)) !== true; } catch (e) {}
      if (clear) return { x: x, y: y, cx: cx, cy: cy, R: R, deg: (s ? -deg : deg) };
    }
    return { err: 'no clear oblique line' }; },
  spawn: function (x, y, vx, vy, owner, type) { var rc = GameManager.getGameController().roundController;
    var id = IdGenerator.instance.gen('g5f'); rc.setProjectileState(ProjectileState.withState(id, owner, type, x, y, vx, vy)); return id; },
  proj: function (id) { var p = GameManager.getGameController().getProjectile(id); if (!p) return null;
    var b = p.getB2DBody(), pos = b.GetPosition(), v = b.GetLinearVelocity();
    return { x: pos.x, y: pos.y, vx: v.x, vy: v.y, speed: Math.sqrt(v.x * v.x + v.y * v.y),
             deadly: p.isDeadlyToOwner ? !!p.isDeadlyToOwner() : null }; },
  tank: function (pid) { var t = GameManager.getGameController().getTank(pid); return t ? { x: t.getX(), y: t.getY(), rot: t.getRotation() } : null; },
  alive: function (pid) { return !!GameManager.getGameController().getTank(pid); },
  grant: function (pid, kind) { var gc = GameManager.getGameController();
    var C = Constants.UPGRADE_TYPES;
    var st = (kind === 'SPAWN') ? SpawnShieldUpgrade.createInitialUpgradeState(IdGenerator.instance.gen('g5s'), pid)
                                : ShieldUpgrade.createInitialUpgradeState(IdGenerator.instance.gen('g5u'), pid);
    gc.roundController.setUpgradeState(st); return { id: st.getId(), type: st.getType() }; },
  /* 真坦克 body 上所有 upgrade 夹具（type → 半径），用来做 ground truth */
  realFx: function (pid) { var gc = GameManager.getGameController(), t = gc.getTank(pid);
    if (!t || !t.getB2DBody()) return { err: 'no tank' };
    var out = [], f = t.getB2DBody().GetFixtureList();
    while (f) { var u = null; try { u = f.GetUserData(); } catch (e) {}
      if (u && typeof u.type === 'number') { var sh = f.GetShape(), fd = f.GetFilterData();
        out.push({ type: u.type, r: sh.m_radius, cat: fd.categoryBits, mask: fd.maskBits }); }
      f = f.GetNext(); }
    return { fixtures: out,
             hasRealShield: out.some(function (x) { return x.type === Constants.UPGRADE_TYPES.SHIELD; }),
             hasSpawnShield: out.some(function (x) { return x.type === Constants.UPGRADE_TYPES.SPAWN_SHIELD; }) }; },
  /* 沙箱侧：候选体上有没有护盾夹具（= 检测器的输出） */
  sbHasShield: function (pid) { var ad = window.__f.ad(pid);
    var s = ad.getFusedCandidateShield(0); return { has: !!s.has, r: s.r || null, cat: s.categoryBits || null,
      mask: s.maskBits || null, maskHasMaze: s.maskHasMaze === undefined ? null : s.maskHasMaze }; },
  upLife: function (pid) { var gc = GameManager.getGameController();
    var T = Constants.UPGRADE_TYPES.SHIELD, u = null;
    try { u = gc.getUpgradeByPlayerIdAndType(pid, T); } catch (e) {}
    return u ? { id: u.getId ? u.getId() : null, life: (u.getField ? u.getField('lifetime') : null) } : null; },
  vtime: function () { try { return window.__vt ? window.__vt.t : null; } catch (e) { return null; } }
}; return { ok: true }; })()`;

(async () => {
  const res = { startedAt: new Date().toISOString(), steps: [], errors: [] };
  const m = new Match();
  const add = (n, o) => { res.steps.push(Object.assign({ name: n }, o)); console.log(n + ' ' + JSON.stringify(o)); return o; };
  try {
    await m.open({ humanIds: ['tank_a', 'tank_b', 'tank_c'], aiCount: 0, vantCount: 0 });
    await m.clearControl(); await m.eval(INSTALL);
    const P = await m.eval('window.__f.findPose()'); res.pose = P;
    for (const t of [['tank_a', P.x, P.y, 0], ['tank_b', 65, 45, 0], ['tank_c', 5, 45, 0]]) await m.teleport(t[0], t[1], t[2], t[3]).catch(() => { });
    await m.eval(`window.__f.grant('tank_a','SHIELD')`);
    await m.pump(2, { yieldMs: 0 });
    res.version = { sandbox: await m.eval('VantageSandbox.getFrameDtSec ? VantageSandbox.getFrameDtSec() : null') };

    /* ---------- F. 假阳率【全象限】+ SPAWN_SHIELD 混淆项 ---------- */
    const sample = async () => {
      const r = await m.eval(`(() => { var o = {};
        ['tank_a','tank_c'].forEach(function (pid) {
          var rl = window.__f.realFx(pid), sb = window.__f.sbHasShield(pid);
          o[pid] = { realShield: rl.hasRealShield, spawnShield: rl.hasSpawnShield,
                     realFx: rl.fixtures, sbShield: sb.has, sbR: sb.r }; });
        return o; })()`);
      return r;
    };
    let q = { tp: 0, fp: 0, tn: 0, fn: 0 };
    const tally = (real, sb) => { if (real && sb) q.tp++; else if (!real && sb) q.fp++; else if (!real && !sb) q.tn++; else q.fn++; };
    let s0 = await sample();
    add('F0_quadrants_initial', { tank_a: s0.tank_a, tank_c: s0.tank_c, quadrants: q });
    for (let i = 0; i < 6; i++) { const s = await sample(); tally(s.tank_a.realShield, s.tank_a.sbShield); tally(s.tank_c.realShield, s.tank_c.sbShield); await m.pump(5, { yieldMs: 0 }); }
    add('F1_quadrants_after', { quadrants: q });
    // SPAWN_SHIELD（type=1）混淆项：真 body 上**有**夹具，但检测器**必须说"没有护盾"**
    const sp = await m.eval(`window.__f.grant('tank_c','SPAWN')`);
    await m.pump(3, { yieldMs: 0 });
    const sSp = await sample();
    tally(sSp.tank_c.realShield, sSp.tank_c.sbShield);
    add('F2_spawn_shield_confusion', { grantedType: sp.type, tank_c: sSp.tank_c, quadrants: q,
      detectorSaysNoShield: !sSp.tank_c.sbShield, realBodyHasSpawnShieldFixture: sSp.tank_c.spawnShield });

    /* ---------- B. 斜打镜面反射对拍（保证整条线不撞墙） ---------- */
    const ob = await m.eval(`window.__f.findOblique('tank_a', 28)`);
    res.oblique = ob;
    if (!ob.err) {
      const speed = 8.0, dx = ob.cx - ob.x, dy = ob.cy - ob.y, L = Math.hypot(dx, dy);
      const vx = speed * dx / L, vy = speed * dy / L;
      const b = await m.eval(`window.__f.spawn(${ob.x}, ${ob.y}, ${vx}, ${vy}, 'tank_b', -1)`);
      let prev = null, hitPrev = null, hitNext = null, hitFrame = -1, dAtHit = null;
      for (let f = 0; f < 120; f++) {
        await m.pump(1, { yieldMs: 0 });
        const st = await m.eval(`window.__f.proj(${JSON.stringify(b)})`);
        if (!st) break;
        const t0 = await m.eval(`window.__f.tank('tank_a')`);
        if (prev && (Math.abs(st.vx - prev.vx) > 1e-9 || Math.abs(st.vy - prev.vy) > 1e-9)) {
          hitPrev = prev; hitNext = st; hitFrame = f;
          dAtHit = Math.hypot(hitPrev.x - t0.x, hitPrev.y - t0.y);
          break;
        }
        prev = st;
      }
      if (hitPrev && hitNext) {
        const t0 = await m.eval(`window.__f.tank('tank_a')`);
        const norm = (p) => { const ax = p.x - t0.x, ay = p.y - t0.y, L2 = Math.hypot(ax, ay); return { x: ax / L2, y: ay / L2 }; };
        const refl = (p) => { const n = norm(p), d = hitPrev.vx * n.x + hitPrev.vy * n.y;
          return { vx: hitPrev.vx - 2 * d * n.x, vy: hitPrev.vy - 2 * d * n.y }; };
        const predPrev = refl(hitPrev), predNext = refl(hitNext);
        add('B_oblique_mirror_fixed', {
          spawn: { x: +ob.x.toFixed(3), y: +ob.y.toFixed(3), deg: ob.deg }, bullet: b, hitFrame: hitFrame,
          impactDistFromCenter: +dAtHit.toFixed(4), shieldR: 4.3,
          impactOnShieldSurface: Math.abs(dAtHit - 4.3) < 0.45,
          v_before: { x: hitPrev.vx, y: hitPrev.vy }, v_after: { x: +hitNext.vx.toFixed(6), y: +hitNext.vy.toFixed(6) },
          speedBefore: +hitPrev.speed.toFixed(6), speedAfter: +hitNext.speed.toFixed(6),
          pred_from_prev_frame: { x: +predPrev.vx.toFixed(4), y: +predPrev.vy.toFixed(4) },
          pred_from_after_frame: { x: +predNext.vx.toFixed(4), y: +predNext.vy.toFixed(4) },
          err_prevFrame: +Math.hypot(predPrev.vx - hitNext.vx, predPrev.vy - hitNext.vy).toFixed(4),
          err_afterFrame: +Math.hypot(predNext.vx - hitNext.vx, predNext.vy - hitNext.vy).toFixed(4),
          pass_lt_0_2: Math.hypot(predPrev.vx - hitNext.vx, predPrev.vy - hitNext.vy) < 0.2 });
      } else add('B_oblique_mirror_fixed', { err: 'no bounce', bullet: b, oblique: ob });
    } else add('B_oblique_mirror_fixed', { obliqueErr: ob.err });

    /* ---------- C1. 贴墙自杀（修正版贴墙位姿） ---------- */
    const W = await m.eval('window.__f.findWallPose()');
    res.wallPose = W;
    if (!W.err) {
      await m.teleport('tank_a', W.x, W.y, 0);
      await m.pump(2, { yieldMs: 0 });
      const has = (await m.eval(`window.__f.realFx('tank_a')`)).hasRealShield;
      const tp = await m.eval(`window.__f.tank('tank_a')`);
      if (!tp) add('C1_wall_suicide', { err: 'tank_a gone' });
      else {
        const b5 = await m.eval(`window.__f.spawn(${tp.x}, ${tp.y - 2.5}, 0, -18.0, 'tank_a', -1)`);
        let died = -1;
        for (let f = 0; f < 40; f++) {
          await m.pump(1, { yieldMs: 0 });
          if (!(await m.eval(`window.__f.alive('tank_a')`))) { died = f; break; }
        }
        add('C1_wall_suicide', { wallPose: W, hadShield: has, bullet: b5, tankAt: tp,
          died: died >= 0, deathFrame: died });
      }
    } else add('C1_wall_suicide', { wallErr: W.err });

    /* ---------- E. 护盾寿命（帧号 + dt + 速率） ---------- */
    if (await m.eval(`window.__f.alive('tank_a')`)) {
      await m.teleport('tank_a', P.x, P.y, 0).catch(() => { });
      const up = await m.eval(`window.__f.grant('tank_a','SHIELD')`);
      await m.pump(2, { yieldMs: 0 });
      const t0 = await m.eval(`window.__f.vtime()`);
      const e = { upgradeId: up.id, startVTime: t0, samples: [], vanishFrame: null, vanishVTime: null, mode: 'yieldMs=0' };
      let life0 = (await m.eval(`window.__f.upLife('tank_a')`) || {}).life;
      e.lifeAtStart = life0;
      let f = 0;
      for (; f < 900; f++) {
        await m.pump(1, { yieldMs: 0 });
        if (f % 100 === 0) {
          const ul = await m.eval(`window.__f.upLife('tank_a')`);
          e.samples.push({ f: f, life: ul ? ul.life : null, vtime: await m.eval(`window.__f.vtime()`) });
        }
        const has = (await m.eval(`window.__f.realFx('tank_a')`)).hasRealShield;
        if (!has) { e.vanishFrame = f; e.vanishVTime = await m.eval(`window.__f.vtime()`); break; }
      }
      e.framesPumped = f;
      e.endVTime = await m.eval(`window.__f.vtime()`);
      if (e.vanishFrame !== null && t0 !== null && e.vanishVTime !== null) {
        e.gameSecondsElapsed = +(e.vanishVTime - t0).toFixed(6);
        e.impliedDt = +(e.gameSecondsElapsed / e.vanishFrame).toFixed(6);
        e.implicitFrameDt = 0.02;
        e.framesAtDt002_if6s = Math.round(6.0 / 0.02);
        e.framesAt60fps_if6s = Math.round(6.0 / (1 / 60));
      }
      add('E_lifetime_fixed', e);
    } else add('E_lifetime_fixed', { skipped: 'tank_a dead' });
  } catch (e) { res.errors.push(String((e && e.stack) || e)); }
  finally { try { await m.close(); } catch (e) { } }
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, '_g5_fix.json'), JSON.stringify(res, null, 1));
  console.log('WROTE _g5_fix.json  ERRORS ' + JSON.stringify(res.errors));
  process.exitCode = res.errors.length ? 1 : 0;
})();
