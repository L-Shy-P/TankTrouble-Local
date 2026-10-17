#!/usr/bin/env node
'use strict';
/* ============================================================================
 * G5 收尾第二轮（**只改探针，不动 game_core**）
 *   ① E：护盾寿命（tank_c；报 4 个量：消失帧号 / __vt.t 差 / d(life)/frame / 与 6.0/dt 的关系）
 *      ⚠️ 纪律：显式 setFrameDtSec(游戏实测帧长)
 *   ② B：斜打弹**先诊断后验**（逐帧位置轨迹 → 指出它到底飞哪去了）
 * 一次跑两段（顺序执行，不并发两个进程）。
 * ============================================================================ */
const fs = require('fs'), path = require('path');
const { Match } = require('./match');
const OUT = path.join(__dirname, '_g5_prof');

const INSTALL = `(() => { window.__x = {
  gc: function () { return GameManager.getGameController(); },
  ad: function (pid) { return VantageSandbox.createAdapter(GameManager.getGameController(), pid); },
  pose: function (pid) { var t = GameManager.getGameController().getTank(pid); return t ? { x: t.getX(), y: t.getY(), rot: t.getRotation() } : null; },
  vtime: function () { try { return window.__vt ? window.__vt.t : null; } catch (e) { return null; } },
  dt: function () { try { return VantageSandbox.getFrameDtSec(); } catch (e) { return null; } },
  setDt: function (v) { try { VantageSandbox.setFrameDtSec(v); return VantageSandbox.getFrameDtSec(); } catch (e) { return null; } },
  findPose: function () { var gc = GameManager.getGameController(), maze = gc.getMaze(), world = gc.getB2DWorld();
    var T = Constants.MAZE_TILE_SIZE.m, out = [];
    for (var i = 1; i < maze.width - 1; i++) for (var j = 2; j < maze.height - 1; j++) {
      var x = i * T + T / 2, y = j * T + T / 2, cA = false, cB = false;
      try { cA = B2DUtils.checkLineForMazeCollision(world, Box2D.Common.Math.b2Vec2.Make(x, y - 1.2), Box2D.Common.Math.b2Vec2.Make(x, y - 2.4)) !== true;
            cB = B2DUtils.checkLineForMazeCollision(world, Box2D.Common.Math.b2Vec2.Make(x, y - 2.4), Box2D.Common.Math.b2Vec2.Make(x, y - 3.6)) !== true; } catch (e) {}
      if (cA && cB) out.push({ x: x, y: y, rot: 0 }); }
    return out; },
  grant: function (pid) { var gc = GameManager.getGameController();
    var st = ShieldUpgrade.createInitialUpgradeState(IdGenerator.instance.gen('g5u'), pid);
    gc.roundController.setUpgradeState(st); return st.getId(); },
  realShield: function (pid) { var gc = GameManager.getGameController(), t = gc.getTank(pid);
    if (!t || !t.getB2DBody()) return { has: false };
    var want = Constants.UPGRADE_TYPES.SHIELD, f = t.getB2DBody().GetFixtureList(), out = { has: false };
    while (f) { var u = null; try { u = f.GetUserData(); } catch (e) {}
      if (u && u.type === want) out = { has: true, r: f.GetShape().m_radius }; f = f.GetNext(); }
    return out; },
  life: function (pid) { var gc = GameManager.getGameController();
    var u = null; try { u = gc.getUpgradeByPlayerIdAndType(pid, Constants.UPGRADE_TYPES.SHIELD); } catch (e) {}
    return u ? (u.getField ? u.getField('lifetime') : null) : null; },
  spawn: function (x, y, vx, vy, owner, type) { var rc = GameManager.getGameController().roundController;
    var id = IdGenerator.instance.gen('g5x'); rc.setProjectileState(ProjectileState.withState(id, owner, type, x, y, vx, vy)); return id; },
  proj: function (id) { var gc = GameManager.getGameController(); var p = null;
    try { p = gc.getProjectile(id); } catch (e) { p = null; }
    if (!p) return { gone: true };
    var b = p.getB2DBody(); if (!b) return { gone: true, noBody: true };
    var pos = b.GetPosition(), v = b.GetLinearVelocity();
    return { gone: false, x: pos.x, y: pos.y, vx: v.x, vy: v.y,
             speed: Math.sqrt(v.x * v.x + v.y * v.y),
             done: (p.done ? !!p.done() : null), deadly: (p.isDeadlyToOwner ? !!p.isDeadlyToOwner() : null) }; },
  /* 逐帧位置 → 到坦克心的距离（诊断"它飞哪去了"） */
  dist: function (id, pid) { var gc = GameManager.getGameController(); var p = null;
    try { p = gc.getProjectile(id); } catch (e) { p = null; }
    if (!p) return null;
    var t = gc.getTank(pid); if (!t) return null;
    var pos = p.getB2DBody().GetPosition();
    return Math.sqrt(Math.pow(pos.x - t.getX(), 2) + Math.pow(pos.y - t.getY(), 2)); },
  /* 斜打发射点：绕坦克心 R 的弧上找"到坦克心整条线不撞墙"的点；并报该点到心的距离 */
  oblique: function (pid, deg, R) { var gc = GameManager.getGameController(), world = gc.getB2DWorld(), t = gc.getTank(pid);
    if (!t) return { err: 'no tank' };
    var cx = t.getX(), cy = t.getY();
    for (var s = 0; s < 2; s++) {
      var d = (s ? -1 : 1) * deg * Math.PI / 180.0;
      var x = cx + Math.sin(d) * R, y = cy - Math.cos(d) * R;
      var clear = false;
      try { clear = B2DUtils.checkLineForMazeCollision(world,
              Box2D.Common.Math.b2Vec2.Make(x, y), Box2D.Common.Math.b2Vec2.Make(cx, cy)) !== true; } catch (e) {}
      if (clear) return { x: x, y: y, cx: cx, cy: cy, R: R, deg: (s ? -deg : deg) };
    }
    return { err: 'no clear oblique line' }; }
}; return { ok: true }; })()`;

(async () => {
  const res = { startedAt: new Date().toISOString(), steps: [], errors: [] };
  const m = new Match();
  const add = (n, o) => { res.steps.push(Object.assign({ name: n }, o)); console.log(n + ' ' + JSON.stringify(o).slice(0, 1200)); return o; };
  try {
    await m.open({ humanIds: ['tank_a', 'tank_b', 'tank_c'], aiCount: 0, vantCount: 0 });
    await m.clearControl(); await m.eval(INSTALL);
    const poses = await m.eval('window.__x.findPose()');
    res.poseCount = poses.length;
    const P = poses[0], Q = poses[2] || poses[1];
    for (const t of [['tank_a', P.x, P.y, 0], ['tank_b', 65, 45, 0], ['tank_c', Q.x, Q.y, 0]]) await m.teleport(t[0], t[1], t[2], t[3]).catch(() => { });

    /* ================= ① E：护盾寿命（tank_c；不碰 tank_a） ================= */
    const t0 = await m.eval('window.__x.vtime()');
    await m.pump(100, { yieldMs: 0 });
    const t1 = await m.eval('window.__x.vtime()');
    const dtGame = (t1 !== null && t0 !== null) ? +((t1 - t0) / 100).toFixed(9) : null;
    const dtApplied = await m.eval(`window.__x.setDt(${dtGame || 0.02})`);
    const upId = await m.eval(`window.__x.grant('tank_c')`);
    await m.pump(2, { yieldMs: 0 });
    const e = { upgradeId: upId, dtGame: dtGame, dtAppliedToSandbox: dtApplied,
      startVTime: await m.eval('window.__x.vtime()'), samples: [], vanishFrame: null, vanishVTime: null };
    e.lifeAtStart = await m.eval('window.__x.life(\'tank_c\')');
    let f = 0, lifePrev = e.lifeAtStart;
    for (; f < 700; f++) {
      await m.pump(1, { yieldMs: 0 });
      const lf = await m.eval(`window.__x.life('tank_c')`);
      if (f < 6 || f % 60 === 0) e.samples.push({ f: f, life: lf, vt: await m.eval('window.__x.vtime()') });
      const has = (await m.eval(`window.__x.realShield('tank_c')`)).has;
      if (!has) { e.vanishFrame = f; e.vanishVTime = await m.eval('window.__x.vtime()'); break; }
      lifePrev = lf;
    }
    e.framesPumped = f;
    e.lifeAtEnd = await m.eval(`window.__x.life('tank_c')`);
    e.sampleTail = { life: e.lifeAtEnd, f: f };
    if (e.vanishFrame !== null && e.startVTime !== null && e.vanishVTime !== null) {
      e.vTimeDelta = +(e.vanishVTime - e.startVTime).toFixed(6);
      e.expectedFramesIf6s = dtGame ? Math.round(6.0 / dtGame) : null;
      e.ratio_actual_over_expected = e.expectedFramesIf6s ? +(e.vanishFrame / e.expectedFramesIf6s).toFixed(4) : null;
    }
    if (e.lifeAtStart !== null && e.lifeAtEnd !== null && e.framesPumped > 0) {
      e.dLifePerFrame = +((e.lifeAtStart - e.lifeAtEnd) / e.framesPumped).toFixed(9);
      e.impliedTotalFrames = e.dLifePerFrame > 0 ? Math.round(6.0 / e.dLifePerFrame) : null;
    }
    add('E_lifetime_v2', e);

    /* ================= ② B：斜打弹【先诊断】 ================= */
    const ob = await m.eval('window.__x.oblique(\'tank_a\', 25, 6.0)');
    if (ob.err) add('B_diag', { obliqueErr: ob.err });
    else {
      const speed = 8.0, dx = ob.cx - ob.x, dy = ob.cy - ob.y, L = Math.hypot(dx, dy);
      const b = await m.eval(`window.__x.spawn(${ob.x}, ${ob.y}, ${speed * dx / L}, ${speed * dy / L}, 'tank_b', -1)`);
      const diag = { spawn: { x: +ob.x.toFixed(3), y: +ob.y.toFixed(3), deg: ob.deg, distToCenter: +L.toFixed(3) },
                     bullet: b, frames: [] };
      let prev = null, hitPrev = null, hitNext = null, hitFrame = -1, dHit = null;
      for (let k = 0; k < 60; k++) {
        const st = await m.eval(`window.__x.proj(${JSON.stringify(b)})`);
        const d = await m.eval(`window.__x.dist(${JSON.stringify(b)}, 'tank_a')`);
        if (k < 26) diag.frames.push({ f: k, gone: !!st.gone, d: d === null ? null : +d.toFixed(3),
          x: st.gone ? null : +st.x.toFixed(3), y: st.gone ? null : +st.y.toFixed(3),
          vx: st.gone ? null : +st.vx.toFixed(3), vy: st.gone ? null : +st.vy.toFixed(3) });
        if (st.gone) { diag.goneAtFrame = k; break; }
        if (prev && (Math.abs(st.vx - prev.vx) > 1e-9 || Math.abs(st.vy - prev.vy) > 1e-9)) {
          hitPrev = prev; hitNext = st; hitFrame = k; dHit = d; break;
        }
        prev = st;
        await m.pump(1, { yieldMs: 0 });
      }
      diag.hitFrame = hitFrame; diag.impactDist = dHit === null ? null : +dHit.toFixed(4);
      diag.impactOnShieldSurface = dHit === null ? null : (Math.abs(dHit - 4.3) < 0.5);
      diag.minDist = diag.frames.reduce((a, x) => (x.d !== null && (a === null || x.d < a) ? x.d : a), null);
      if (hitPrev && hitNext) {
        const t0b = await m.eval(`window.__x.pose('tank_a')`);
        const nrm = (p) => { const ax = p.x - t0b.x, ay = p.y - t0b.y, L2 = Math.hypot(ax, ay); return { x: ax / L2, y: ay / L2 }; };
        const refl = (p) => { const n = nrm(p), dd = hitPrev.vx * n.x + hitPrev.vy * n.y;
          return { vx: hitPrev.vx - 2 * dd * n.x, vy: hitPrev.vy - 2 * dd * n.y }; };
        const p1 = refl(hitPrev), p2 = refl(hitNext);
        diag.v_before = { x: hitPrev.vx, y: hitPrev.vy };
        diag.v_after = { x: +hitNext.vx.toFixed(6), y: +hitNext.vy.toFixed(6) };
        diag.speedBefore = +hitPrev.speed.toFixed(6); diag.speedAfter = +hitNext.speed.toFixed(6);
        diag.err_prevFrame = +Math.hypot(p1.vx - hitNext.vx, p1.vy - hitNext.vy).toFixed(4);
        diag.err_afterFrame = +Math.hypot(p2.vx - hitNext.vx, p2.vy - hitNext.vy).toFixed(4);
        diag.pass_lt_0_2 = diag.err_prevFrame < 0.2;
      }
      add('B_diag_and_result', diag);
    }
  } catch (e) { res.errors.push(String((e && e.stack) || e)); }
  finally { try { await m.close(); } catch (e) { } }
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, '_g5_final.json'), JSON.stringify(res, null, 1));
  console.log('WROTE _g5_final.json  ERRORS ' + JSON.stringify(res.errors));
  process.exitCode = res.errors.length ? 1 : 0;
})();
