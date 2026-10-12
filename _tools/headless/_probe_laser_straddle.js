'use strict';
/* ============================================================================
 * 实测探针：激光「一帧跨过坦克」时，游戏判不判死？沙箱判不判？两边一致吗？
 *   —— 2026-10-11 重做（当前确定性修复后的 clock.js/match.js）
 *
 * 只读产品代码；本文件是【新建的探针】，不改 game_core/ 一个字节。
 *
 * 做法：
 *   ① 真游戏：tank_a 持激光（WEAPON_TYPES.LASER=0）在长直道开火；
 *      读激光逐帧真实位置/速度 → 得到下一帧线段 [p0, p1]（实测步长，不硬编码）。
 *   ② 对照控制：先把 tank_b 摆到弹道外，泵 1 帧 → 确认「不摆上去就不会死」。
 *   ③ 同一局面上搜摆位：用 tank_b 的真实夹具多边形（车体+炮塔）搜索
 *      「线段命中多边形、但两个采样点都离几何 >0.05m」的位姿（点采样必漏）。
 *   ④ 沙箱判：adapter.checkDeath / simulateTankBatchJsFused / simulateBulletTracks
 *      —— 全部只读调用，不碰产品代码。
 *   ⑤ 游戏判：把 tank_b 传送到该位姿，泵 1 帧，读 TANK_KILLED / 坦克是否还在 /
 *      致命碰撞事件（含弹 id、命中坦克）。
 *
 * 产物：stdout（摘要）+ prof/probe_lsx_report.json（小）
 * 用法：node _tools/headless/_probe_laser_straddle.js [--kinds=full_edge,miss_oblique,miss_turret,miss_corner]
 * ============================================================================ */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Match } = require('./match');

const TILE = 10;
const WALL_HALF = 0.4;                 // 墙面在格边 ±0.4（上一份实测）
const PROFDIR = path.join(__dirname, 'prof');
const OUT = {};

/* ---------------- 版本指纹 ---------------- */
const FILES = [
  'game_core/js/vantage_tree.js',
  'game_core/js/vantage_sandbox.js',
  '_tools/headless/match.js',
  '_tools/headless/clock.js',
  '_tools/headless/cdp.js',
  'game_core/index.html',
  'game_core/js/418577fd210ad079ea3d1e5e04050fe0.js',   // Projectile/.../Maze
  'game_core/js/b714588dc4621fe104113111ba90b1a7.js',   // Constants + B2DUtils
  'game_core/js/7b2ed8ad3598d7321f8f3d2b04b1eac8.js',   // Weapon/LaserWeapon/Tank
  'game_core/js/f1a5ef972c273fb89a098cb50b0f22e7.js',   // Box2D（CCD/TOI）
];
function fingerprints() {
  const out = [];
  for (const rel of FILES) {
    const p = path.join(__dirname, '..', '..', rel);
    try {
      const st = fs.statSync(p);
      const md5 = crypto.createHash('md5').update(fs.readFileSync(p)).digest('hex');
      out.push({ file: rel, bytes: st.size, mtime: st.mtime.toISOString(), md5 });
    } catch (e) { out.push({ file: rel, err: String(e.message || e) }); }
  }
  return out;
}

/* ---------------- 页面内辅助（只读游戏对象 + 调沙箱只读接口） ---------------- */
const HELPERS = `
window.__vtEv = window.__vtEv || [];
window.__vtWarns = window.__vtWarns || [];
if (!window.__vtWarnHooked) {
  window.__vtWarnHooked = true;
  var __ow = console.warn;
  console.warn = function () {
    try {
      window.__vtWarns.push(Array.prototype.slice.call(arguments).join(' '));
      if (window.__vtWarns.length > 80) window.__vtWarns.shift();
    } catch (e) {}
    return __ow.apply(console, arguments);
  };
}
window.__vtL = {
  a: null,
  r: function (x) { return Math.round(x * 10000) / 10000; },
  shape: function (pid) {
    var gc = GameManager.getGameController();
    var t = gc && gc.getTank(pid);
    if (!t) return null;
    var b = t.getB2DBody();
    if (!b) return null;
    var out = { circles: [], polys: [] };
    for (var f = b.GetFixtureList(); f; f = f.GetNext()) {
      var sh = f.GetShape();
      var ud = f.GetUserData() || {};
      if (sh.GetType() === Box2D.Collision.Shapes.b2Shape.e_circleShape) {
        out.circles.push({ x: sh.m_p.x, y: sh.m_p.y, r: sh.m_radius, type: ud.type || null });
      } else {
        var vs = (typeof sh.GetVertices === 'function' ? sh.GetVertices() : sh.m_vertices) || [];
        var pts = [];
        for (var i = 0; i < vs.length; i++) pts.push({ x: vs[i].x, y: vs[i].y });
        out.polys.push({ verts: pts, type: ud.type || null });
      }
    }
    return out;
  },
  make: function (pid) { this.a = VantageSandbox.createAdapter(GameManager.getGameController(), pid || 'tank_b'); return !!this.a; },
  setDt: function (dt) {
    if (!this.a) this.make('tank_b');
    VantageSandbox.setFrameDtSec(dt);
    this.a.setFrameDtSec(dt);
    return this.a.getFrameDtSec();
  },
  meta: function () {
    if (!this.a) this.make('tank_b');
    return {
      prefilterRadius: this.a.constants.DEATH_PREFILTER_RADIUS,
      bulletRadius: this.a.constants.BULLET_RADIUS,
      tankWidth: this.a.constants.TANK_WIDTH, tankHeight: this.a.constants.TANK_HEIGHT,
      turretW: this.a.constants.TURRET_WIDTH, turretH: this.a.constants.TURRET_HEIGHT,
      turretOffY: this.a.constants.TURRET_OFFSET_Y,
      frameDt: this.a.getFrameDtSec(),
      fusedEnabled: VantageSandbox.fusedEnabled(),
      laserRadius: Constants.LASER.RADIUS.m,
      laserSpeed: Constants.LASER.SPEED.m,
      laserLifetime: Constants.LASER_MAX_LIFETIME,
      bounceWindowMs: Constants.PROJECTILE_BOUNCE_TIMEOUT_WINDOW,
      bounceCount: Constants.PROJECTILE_BOUNCE_TIMEOUT_COUNT,
      weaponTypes: Constants.WEAPON_TYPES
    };
  },
  laser: function () {
    var gc = GameManager.getGameController();
    var ps = gc.getProjectiles();
    for (var k in ps) {
      var p = ps[k];
      if (p.getType() !== 0) continue;
      var b = p.getB2DBody(); var v = b ? b.GetLinearVelocity() : null;
      var rad = null; try { rad = b.GetFixtureList().GetShape().m_radius; } catch (e) {}
      return { id: k, x: this.r(p.getX()), y: this.r(p.getY()),
               vx: v ? this.r(v.x) : null, vy: v ? this.r(v.y) : null, sp: v ? this.r(v.Length()) : null,
               rad: rad, ta: this.r(p.getTimeAlive()), la: p.lifetime, nb: p.bounces.length,
               dto: p.isDeadlyToOwner(), f: window.__vt.steps };
    }
    return null;
  },
  giveLaser: function (pid) {
    var gc = GameManager.getGameController();
    var ws = LaserWeapon.createInitialWeaponState(IdGenerator.instance.gen('lw'), pid);
    gc.roundController.setWeaponState(ws);
    var w = gc.getActiveWeapon(pid);
    return { activeType: w ? w.getType() : null };
  },
  resetEv: function () { window.__vtEv.length = 0; return 0; },
  installEvents: function () {
    if (this._evInst) return 'already';
    this._evInst = true;
    var gc = GameManager.getGameController();
    var self = this;
    var summarize = function (evt, data) {
      var o = { evt: evt, f: window.__vt.steps, t: Math.round(window.__vt.t * 100) / 100 };
      try {
        if (data && typeof data === 'object') {
          if (data.projectile) {
            var p = data.projectile, b = p.getB2DBody(), v = b ? b.GetLinearVelocity() : null;
            o.pid = p.getId(); o.pty = p.getType(); o.pOwner = p.getPlayerId();
            o.px = self.r(p.getX()); o.py = self.r(p.getY());
            o.vx = v ? self.r(v.x) : null; o.vy = v ? self.r(v.y) : null;
            o.nb = p.bounces.length; o.ta = self.r(p.getTimeAlive());
          }
          if (data.getVictimPlayerId) o.victim = data.getVictimPlayerId();
          if (data.getKillerPlayerId) o.killer = data.getKillerPlayerId();
          if (data.getPlayerId) o.playerId = data.getPlayerId();
          if (data.getWeaponType) o.weapon = data.getWeaponType();
          if (data.tankA && data.tankA.getPlayerId) o.tankA = data.tankA.getPlayerId();
          if (data.tankB && data.tankB.getPlayerId) o.tankB = data.tankB.getPlayerId();
        } else if (typeof data === 'string' || typeof data === 'number') { o.data = data; }
      } catch (e) { o.err = String(e && e.message || e); }
      return o;
    };
    var rmodel = gc.roundController && gc.roundController.model;
    if (rmodel && rmodel.addEventListener) {
      rmodel.addEventListener(function (ctx, gid, evt, data) { window.__vtEv.push(summarize(evt, data)); }, null, gc.getId());
    }
    return 'installed';
  },
  fused: function (pose, frames, dtOpt) {
    if (!this.a) this.make('tank_b');
    if (dtOpt) { VantageSandbox.setFrameDtSec(dtOpt); this.a.setFrameDtSec(dtOpt); }
    var ops = [{ inputs: { forward: false, back: false, left: false, right: false } }];
    var res = this.a.simulateTankBatchJsFused(pose, ops, frames, {
      startPose: pose, auditPurpose: 'jsConfirm', tGlobal: 0, nowTGlobal: 0, threats: []
    });
    var s = null; try { s = this.a.getLastFusedBatchSummary(); } catch (e) {}
    var proxMin = null, prox = null, bulletRad = null;
    if (s && s.geometry && s.geometry.proximity) {
      prox = s.geometry.proximity;
      for (var k in prox) {
        var g = prox[k]; if (!g) continue;
        if (proxMin === null || g.polyGap < proxMin) proxMin = g.polyGap;
        if (g.bullet && bulletRad === null) bulletRad = g.bullet.r;
      }
    }
    return {
      dead: res && res[0] ? res[0].dead : null,
      deathFrame: res && res[0] ? res[0].deathFrame : null,
      deadArr: s ? s.dead : null, dfs: s ? s.deathFrames : null,
      contacts: s ? s.contacts : null,
      geometryFallback: s ? !!s.geometryFallback : null,
      proxMin: proxMin, bulletRadUsed: bulletRad,
      prox: prox, placements: s ? (s.placements || []).map(function (p) {
        return { pid: p.pid, active: p.active, src: p.src, x: p.x, y: p.y, vx: p.vx, vy: p.vy };
      }) : null
    };
  },
  check: function (pose, pts) {
    if (!this.a) this.make('tank_b');
    return this.a.checkDeath(pose, pts);
  },
  track: function (frames) {
    if (!this.a) this.make('tank_b');
    var tracks = this.a.simulateBulletTracks(frames, null);
    return (tracks || []).map(function (t) { return { id: t.id, frameDt: t.frameDt, frames: t.frames.slice(0, frames + 1) }; });
  },
  trackJudge: function (pose, frames, dtOpt) {
    if (dtOpt) { VantageSandbox.setFrameDtSec(dtOpt); this.a.setFrameDtSec(dtOpt); }
    var trs = this.track(frames);
    var first = -1, detail = [];
    for (var k = 0; k <= frames; k++) {
      var pts = [];
      for (var ti = 0; ti < trs.length; ti++) {
        var f = trs[ti].frames[k];
        if (f && f.alive) pts.push({ x: f.x, y: f.y });
      }
      var hit = pts.length ? this.check(pose, pts) : false;
      detail.push({ k: k, pts: pts.length, hit: hit });
      if (hit && first < 0) first = k;
    }
    return { dead: first >= 0, deathFrame: first, detail: detail, tracks: trs };
  },
  warns: function (re) {
    var out = [];
    for (var i = 0; i < window.__vtWarns.length; i++) {
      var s = window.__vtWarns[i];
      if (!re || new RegExp(re).test(s)) out.push(s);
    }
    return out.slice(-8);
  }
};
`;

/* ---------------- Node 侧几何（全部用游戏真实夹具顶点，不硬编码形状） ---------------- */
const r4 = (x) => Math.round(x * 10000) / 10000;
const vsub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });
const vlen = (a) => Math.sqrt(a.x * a.x + a.y * a.y);
const dist = (a, b) => vlen(vsub(a, b));
function toWorld(pts, C, rot) {
  const c = Math.cos(rot), s = Math.sin(rot);
  return pts.map((p) => ({ x: C.x + c * p.x - s * p.y, y: C.y + s * p.x + c * p.y }));
}
function pointInPoly(p, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if (((a.y > p.y) !== (b.y > p.y)) &&
        (p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x)) inside = !inside;
  }
  return inside;
}
function segInt(a, b, c, d) {
  const d1 = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  const d2 = (b.x - a.x) * (d.y - a.y) - (b.y - a.y) * (d.x - a.x);
  const d3 = (d.x - c.x) * (a.y - c.y) - (d.y - c.y) * (a.x - c.x);
  const d4 = (d.x - c.x) * (b.y - c.y) - (d.y - c.y) * (b.x - c.x);
  return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0));
}
function segHitsPoly(a, b, poly) {
  if (pointInPoly(a, poly) || pointInPoly(b, poly)) return true;
  for (let i = 0; i < poly.length; i++) if (segInt(a, b, poly[i], poly[(i + 1) % poly.length])) return true;
  return false;
}
function segHitsTank(a, b, polys) { return polys.some((poly) => segHitsPoly(a, b, poly)); }
function distPointSeg(p, a, b) {
  const ex = b.x - a.x, ey = b.y - a.y, el = ex * ex + ey * ey;
  let t = el > 0 ? ((p.x - a.x) * ex + (p.y - a.y) * ey) / el : 0;
  t = Math.max(0, Math.min(1, t));
  const qx = a.x + ex * t - p.x, qy = a.y + ey * t - p.y;
  return Math.sqrt(qx * qx + qy * qy);
}
/** 与沙箱 fusedPointPolygonGap 同口径：凸多边形内 → -minD-r；外 → +minD-r */
function pointPolyGap(p, poly, r) {
  const inside = pointInPoly(p, poly);
  let m = Infinity;
  for (let i = 0; i < poly.length; i++) m = Math.min(m, distPointSeg(p, poly[i], poly[(i + 1) % poly.length]));
  return (inside ? -m : m) - r;
}
/** 点到坦克（凸夹具并集）的 gap；内点=负 */
function gapToTank(p, polys, r) {
  let m = Infinity;
  for (const poly of polys) m = Math.min(m, pointPolyGap(p, poly, r));
  return m;
}
/** 线段与凸多边形的相交段总长（弦长） */
function segPolyChord(a, b, poly) {
  const n = poly.length, ts = [0, 1];
  for (let i = 0; i < n; i++) {
    const c = poly[i], d = poly[(i + 1) % n];
    if (!segInt(a, b, c, d)) continue;
    const rx = b.x - a.x, ry = b.y - a.y;
    const sx = d.x - c.x, sy = d.y - c.y;
    const den = rx * sy - ry * sx;
    if (Math.abs(den) < 1e-12) continue;
    const t = ((c.x - a.x) * sy - (c.y - a.y) * sx) / den;
    if (t > 0 && t < 1) ts.push(t);
  }
  ts.sort((x, y) => x - y);
  let total = 0, L = dist(a, b);
  for (let i = 0; i + 1 < ts.length; i++) {
    const tm = (ts[i] + ts[i + 1]) / 2;
    const p = { x: a.x + (b.x - a.x) * tm, y: a.y + (b.y - a.y) * tm };
    if (pointInPoly(p, poly)) total += (ts[i + 1] - ts[i]) * L;
  }
  return total;
}
function chordOfSegment(a, b, polys) {
  let m = 0;
  for (const poly of polys) m = Math.max(m, segPolyChord(a, b, poly));
  return m;
}
function localPolysOf(shape) { return (shape.polys || []).map((p) => p.verts); }
function worldPolysOf(localPolys, C, rot) { return localPolys.map((p) => toWorld(p, C, rot)); }

const key = (x, y) => x + ',' + y;
function wallClearance(p, openSet) {
  const tx = Math.floor(p.x / TILE), ty = Math.floor(p.y / TILE);
  if (!openSet.has(key(tx, ty))) return -999;
  const fx = p.x - tx * TILE, fy = p.y - ty * TILE;
  let clr = Infinity;
  if (!openSet.has(key(tx - 1, ty))) clr = Math.min(clr, fx - WALL_HALF);
  if (!openSet.has(key(tx + 1, ty))) clr = Math.min(clr, (TILE - WALL_HALF) - fx);
  if (!openSet.has(key(tx, ty - 1))) clr = Math.min(clr, fy - WALL_HALF);
  if (!openSet.has(key(tx, ty + 1))) clr = Math.min(clr, (TILE - WALL_HALF) - fy);
  return clr;
}
function silhouetteSamples(localPolys, step) {
  let mnx = Infinity, mxx = -Infinity, mny = Infinity, mxy = -Infinity;
  for (const poly of localPolys) for (const v of poly) {
    mnx = Math.min(mnx, v.x); mxx = Math.max(mxx, v.x);
    mny = Math.min(mny, v.y); mxy = Math.max(mxy, v.y);
  }
  const out = [];
  for (let x = mnx; x <= mxx + 1e-9; x += step)
    for (let y = mny; y <= mxy + 1e-9; y += step) {
      const p = { x, y };
      if (localPolys.some((poly) => pointInPoly(p, poly))) out.push(p);
    }
  return out;
}
function tankFits(C, rot, localPolys, openSet, margin) {
  const pts = silhouetteSamples(localPolys, 0.5);
  const w = toWorld(pts, C, rot);
  for (const p of w) if (wallClearance(p, openSet) < margin) return false;
  return true;
}
function segmentClear(p1, p2, openSet, margin) {
  const len = dist(p1, p2), n = Math.max(2, Math.ceil(len / 0.2));
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const p = { x: p1.x + (p2.x - p1.x) * t, y: p1.y + (p2.y - p1.y) * t };
    if (wallClearance(p, openSet) < margin) return false;
  }
  return true;
}
const DIRS = [
  { x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 },
  { x: Math.SQRT1_2, y: Math.SQRT1_2 }, { x: -Math.SQRT1_2, y: Math.SQRT1_2 },
  { x: Math.SQRT1_2, y: -Math.SQRT1_2 }, { x: -Math.SQRT1_2, y: -Math.SQRT1_2 },
];
// 发射只用 4 个轴向：实测斜向开火出现过方向反向/弹道异常，轴向稳定。
const DIRS_FIRE = [{ x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 }];
const rotForDir = (d) => Math.atan2(d.x, -d.y);
function clearRun(center, d, openSet, maxLen) {
  let t = 0;
  if (wallClearance(center, openSet) < 0.45) return 0;
  while (t < maxLen) {
    const p = { x: center.x + d.x * (t + 0.25), y: center.y + d.y * (t + 0.25) };
    if (wallClearance(p, openSet) < 0.45) break;
    t += 0.25;
  }
  return t;
}

/* ---------------- 摆位搜索 ----------------
 * 位姿参数：坦克中心 C = segMid + sA*u + d*n（u=激光方向, n=u 左法线）；
 *           rot = 激光方向相对坦克局部 +x（车宽轴）转 -θ。
 * trueHit = 线段 ∩（车体 ∪ 炮塔）真实夹具多边形
 * g05/g25 = 两采样点到多边形的距离 - 半径（负 = 该点采样路径能看见）
 * chord   = 线段穿过多边形的弦长（取各夹具最大）
 */
function tankFitsPts(C, rot, silPts, openSet, margin) {
  const c = Math.cos(rot), s = Math.sin(rot);
  for (const p of silPts) {
    const x = C.x + c * p.x - s * p.y, y = C.y + s * p.x + c * p.y;
    if (wallClearance({ x, y }, openSet) < margin) return false;
  }
  return true;
}
function scoreOfPose(kind, cand) {
  if (kind === 'full_edge') {
    if (!(cand.thetaDeg === 0 && cand.g05 < 0 && cand.chord >= 2.8)) return null;
    return cand.chord * 100 - Math.abs(cand.d) - Math.abs(cand.sA);
  }
  if (kind === 'miss_almostfull') {
    // 近满车宽斜切：两个采样点都在车外 >0.05（fused 漏），弦长尽量大
    if (!(cand.thetaDeg >= 2 && cand.thetaDeg <= 15 && cand.bodyHit && cand.g05 > 0.06 &&
          cand.g25 < -0.02 && cand.chord >= 2.2)) return null;
    return cand.chord;
  }
  if (kind === 'miss_oblique') {
    if (!(cand.thetaDeg >= 4 && cand.g05 > 0.3 && cand.g25 > 0.3 &&
          cand.chord >= 1.2 && cand.chord <= 2.4)) return null;
    return cand.chord;
  }
  if (kind === 'miss_corner') {
    if (!(cand.thetaDeg >= 4 && cand.g05 > 0.5 && cand.g25 > 0.5 && cand.bodyHit &&
          cand.chord >= 0.25 && cand.chord <= 1.2)) return null;
    return cand.chord;
  }
  if (kind === 'miss_turret') {
    if (!(cand.turretHit && cand.g05 > 0.3 && cand.g25 > 0.05 &&
          cand.chord >= 0.2 && cand.chord <= 1.4)) return null;
    return cand.chord;
  }
  if (kind === 'hit_point') {
    if (!(cand.g05 < 0)) return null;
    return -cand.g05;
  }
  return null;
}
function searchPoses(kind, ctx) {
  const { p0, p1, u, n, localPolys, openSet } = ctx;
  const stepLen = dist(p0, p1);
  const mid = { x: (p0.x + p1.x) / 2, y: (p0.y + p1.y) / 2 };
  const silPts = silhouetteSamples(localPolys, 0.5);
  const thetas = kind === 'full_edge' ? [0]
    : (kind === 'miss_almostfull' ? [2, 3, 4, 5, 6, 7, 8, 9, 10]
      : [2, 4, 6, 8, 10, 12, 15, 18, 22, 26, 30, 35, 40, 45, 50, 60, 70, 80, 90]);
  const baseRot = Math.atan2(u.y, u.x);
  const p3 = { x: p0.x + (p1.x - p0.x) * 3, y: p0.y + (p1.y - p0.y) * 3 };
  const top = [];
  let nHit = 0, nFit = 0;
  const pushTop = (cand, score) => {
    cand.score = score;
    top.push(cand);
    top.sort((a, b) => b.score - a.score);
    if (top.length > 6) top.length = 6;
  };
  if (!segmentClear(p0, p3, openSet, 0.15)) return { top, nHit, nFit, stepLen };
  for (const thetaDeg of thetas) {
    const R = baseRot - thetaDeg * Math.PI / 180;
    for (let sA = -2.6; sA <= 2.6001; sA += 0.05) {
      for (let d = -2.6; d <= 2.6001; d += 0.05) {
        const C = { x: mid.x + u.x * sA + n.x * d, y: mid.y + u.y * sA + n.y * d };
        const wp = worldPolysOf(localPolys, C, R);
        if (!segHitsTank(p0, p1, wp)) continue;
        nHit++;
        if (!tankFitsPts(C, R, silPts, openSet, 0.35)) continue;
        nFit++;
        const g05 = Math.min(gapToTank(p0, wp, 0.05), gapToTank(p1, wp, 0.05));
        const g25 = Math.min(gapToTank(p0, wp, 0.25), gapToTank(p1, wp, 0.25));
        const d0 = Math.min(gapToTank(p0, wp, 0), gapToTank(p1, wp, 0));
        const chord = chordOfSegment(p0, p1, wp);
        const polyInfos = localPolys.map((lp, idx) => {
          const maxAbsX = Math.max.apply(null, lp.map((v) => Math.abs(v.x)));
          return { maxAbsX: maxAbsX, hit: segHitsPoly(p0, p1, wp[idx]),
                   g05: Math.min(gapToTank(p0, [wp[idx]], 0.05), gapToTank(p1, [wp[idx]], 0.05)),
                   chord: segPolyChord(p0, p1, wp[idx]) };
        });
        const bodyHit = polyInfos.some((q) => q.maxAbsX > 1.0 && q.hit);
        const turretHit = polyInfos.some((q) => q.maxAbsX <= 1.0 && q.hit);
        const cand = { kind, thetaDeg, R, sA, d, C, wp, g05, g25, d0, chord, bodyHit, turretHit, polyInfos,
                       centerDistMin: Math.min(dist(p0, C), dist(p1, C)) };
        const sc = scoreOfPose(kind, cand);
        if (sc !== null) pushTop(cand, sc);
      }
    }
  }
  return { top, nHit, nFit, stepLen };
}
/* ---------------- 主流程 ---------------- */
(async () => {
  const argv = process.argv.slice(2);
  const argOf = (n, d) => {
    const eq = argv.find((a) => a.indexOf('--' + n + '=') === 0);
    if (eq) return eq.slice(n.length + 3);
    const i = argv.indexOf('--' + n);
    return i < 0 ? d : argv[i + 1];
  };
  const KINDS = String(argOf('kinds', 'full_edge,miss_almostfull,miss_oblique,miss_turret,miss_corner')).split(',').filter(Boolean);
  const MAXOPEN = Number(argOf('maxopen', 8));
  const FRAMES = 3;
  const P = (s) => { console.log(s); (OUT.log = OUT.log || []).push(s); };
  const T0 = Date.now();
  OUT.fingerprints = fingerprints();
  OUT.kinds = KINDS;

  P('=== 版本指纹 ===');
  for (const f of OUT.fingerprints) P(`  ${f.file}  mtime=${f.mtime}  md5=${f.md5}  bytes=${f.bytes}`);

  let m = new Match();
  const closeM = async () => { try { await m.close(); } catch (e) {} m = new Match(); };

  async function requireRound(tag) {
    const info = await m.eval(`(() => {
      var gc = GameManager.getGameController();
      var inRound = GameModel._STATES.IN_ROUND;
      if (!gc) return { gc: null, inRound: inRound };
      var t = gc.getTanks() || {}, ids = []; for (var k in t) ids.push(k);
      return { gc: gc.getState(), inRound: inRound, tanks: ids,
               projs: Object.keys(gc.getProjectiles() || {}).length, mz: !!gc.getMaze() };
    })()`);
    P(`  [守卫 ${tag}] ${JSON.stringify(info)}`);
    if (info.gc !== info.inRound || !info.tanks || info.tanks.length < 2) {
      P(`  !! [守卫 ${tag}] 回合不在进行中/坦克不全 → waitForRound 重等`);
      await m.waitForRound({ roundMaxFrames: 2000 }).catch((e) => P('  waitForRound 失败: ' + e.message));
      const i2 = await m.eval(`(() => {
        var gc = GameManager.getGameController();
        var t = gc.getTanks() || {}, ids = []; for (var k in t) ids.push(k);
        return { gc: gc.getState(), inRound: GameModel._STATES.IN_ROUND, tanks: ids };
      })()`);
      P(`  [守卫 ${tag} 重等后] ${JSON.stringify(i2)}`);
      return i2;
    }
    return info;
  }

  /* ---- 单个 kind：开一局、开火、控制组、沙箱判、游戏判 ---- */
  async function runKind(kind, attempt) {
    const rec = { kind, attempt, t0: ((Date.now() - T0) / 1000).toFixed(1), cycles: [] };
    P(`\n============ ${kind} 第 ${attempt} 次尝试 ============`);
    const tOpen = Date.now();
    await m.open({ humanIds: ['tank_a', 'tank_b'], aiCount: 0, vantCount: 0, rebaseAtMenu: true, bootFrames: 300 });
    P(`  open ${((Date.now() - tOpen) / 1000).toFixed(1)}s waitForRound=${JSON.stringify(m.roundWait)} bootFrames=${m.bootFrames}`);
    await requireRound(kind + '/pre');
    await m.eval(HELPERS);
    await m.eval('window.__vtL.installEvents()');
    const dtSet = await m.eval(`(() => {
      window.__vtDtLog = [];
      var gc = GameManager.getGameController();
      var rm = gc.roundController && gc.roundController.model;
      if (rm && !rm.__lsxOrigUpdate) {
        rm.__lsxOrigUpdate = rm.update;
        rm.update = function (dt) {
          try { window.__vtDtLog.push({ f: window.__vt.steps, dt: dt }); } catch (e) {}
          return rm.__lsxOrigUpdate.call(this, dt);
        };
      }
      return window.__vtL.setDt(1/60);
    })()`);
    rec.meta = await m.eval('window.__vtL.meta()');
    rec.dtSet = dtSet;
    P(`  沙箱: dt=${rec.meta.frameDt}s 预筛半径=${r4(rec.meta.prefilterRadius)} 旧checkDeath弹半径=${rec.meta.bulletRadius} ` +
      `激光真实半径=${rec.meta.laserRadius} 激光速度=${rec.meta.laserSpeed} 寿命=${rec.meta.laserLifetime}s fused=${rec.meta.fusedEnabled}`);

    const mz = await m.maze();
    const openSet = new Set(mz.reachable.map((r) => key(r.x, r.y)));
    rec.maze = { w: mz.width, h: mz.height, reachable: mz.reachable.length };
    const shapeB = await m.eval("window.__vtL.shape('tank_b')");
    const localPolys = localPolysOf(shapeB);
    rec.localPolys = localPolys.map((p) => p.map((v) => [r4(v.x), r4(v.y)]));
    P(`  maze ${mz.width}x${mz.height} 可达 ${mz.reachable.length}; tank_b 夹具多边形=${JSON.stringify(rec.localPolys)}`);

    const cands = [];
    for (const r of mz.reachable) {
      const c = { x: r.x * TILE + TILE / 2, y: r.y * TILE + TILE / 2 };
      if (!tankFits(c, 0, localPolys, openSet, 0.35)) continue;
      for (const d of DIRS_FIRE) {
        const runF = clearRun(c, d, openSet, 60);
        const runB = clearRun(c, { x: -d.x, y: -d.y }, openSet, 60);
        const run = Math.min(runF, runB);
        const runMax = Math.max(runF, runB);
        if (run >= 26 || runMax >= 44) {
          let o3 = 0;
          for (let ox = -1; ox <= 1; ox++) for (let oy = -1; oy <= 1; oy++) if (openSet.has(key(r.x + ox, r.y + oy))) o3++;
          cands.push({ c, d, run, runMax, runF, runB, tile: [r.x, r.y], open3: o3 });
        }
      }
    }
    cands.sort((a, b) => (b.run - a.run) || (b.runMax - a.runMax) || (b.open3 - a.open3));
    if (!cands.length) throw new Error('没有足够空程的直道');
    const spot = cands[0];
    rec.spot = { tile: spot.tile, dir: [r4(spot.d.x), r4(spot.d.y)], run: spot.run, runF: spot.runF, runB: spot.runB };
    P(`  发射位 @(${spot.c.x},${spot.c.y}) dir=(${r4(spot.d.x)},${r4(spot.d.y)}) 前后空程=${spot.runF}/${spot.runB}m`);

    const fitTiles = mz.reachable.filter((r) => tankFits({ x: r.x * TILE + 5, y: r.y * TILE + 5 }, 0, localPolys, openSet, 0.35));
    const far = fitTiles.reduce((best, r) => {
      const dd = (r.x * TILE + 5 - spot.c.x) ** 2 + (r.y * TILE + 5 - spot.c.y) ** 2;
      return (best === null || dd > best.dd) ? { r, dd } : best;
    }, null).r;
    if (!far) throw new Error('没有能放下 tank_b 的远处格');
    await m.teleport('tank_b', far.x * TILE + 5, far.y * TILE + 5, 0);

    const give = await m.eval("window.__vtL.giveLaser('tank_a')");
    rec.give = give;
    if (give.activeType !== 0) throw new Error('tank_a 没拿到激光: ' + JSON.stringify(give));
    await m.teleport('tank_a', spot.c.x, spot.c.y, rotForDir(spot.d));
    await m.pump(6);
    rec.tankAAtFire = await m.eval("(function(){var t=GameManager.getGameController().getTank('tank_a');return t?{x:t.getX(),y:t.getY(),rot:t.getRotation()}:null;})()");
    let L = null;
    for (let shot = 0; shot < 3 && !L; shot++) {
      await m.eval('window.__vtL.resetEv()');
      await m.setControl({ fire: true });
      await m.pump(1);
      await m.setControl({ fire: false });
      for (let i = 0; i < 3 && !L; i++) { await m.pump(1); L = await m.eval('window.__vtL.laser()'); }
      if (!L) {
        const evs = await m.eval('window.__vtEv.slice()');
        P(`  第 ${shot + 1} 次开火没出弹，事件=${JSON.stringify(evs.slice(0, 4))}`);
      }
    }
    if (!L) throw new Error('开火后激光没出现（3 次）');
    rec.spawn = L;
    P(`  激光出现 @(${L.x},${L.y}) v=(${L.vx},${L.vy}) |v|=${L.sp} r=${L.rad}；tank_a 就位 rot=${r4(rec.tankAAtFire ? rec.tankAAtFire.rot : NaN)} ` +
      `预测前向=(${rec.tankAAtFire ? r4(Math.sin(rec.tankAAtFire.rot)) : '?'},${rec.tankAAtFire ? r4(-Math.cos(rec.tankAAtFire.rot)) : '?'})`);
    const farA = fitTiles.reduce((best, r) => {
      if (r.x === far.x && r.y === far.y) return best;
      const dd = Math.min((r.x * TILE + 5 - spot.c.x) ** 2 + (r.y * TILE + 5 - spot.c.y) ** 2,
                          (r.x * TILE + 5 - far.x * TILE - 5) ** 2 + (r.y * TILE + 5 - far.y * TILE - 5) ** 2);
      return (best === null || dd > best.dd) ? { r, dd } : best;
    }, null).r;
    if (!farA) throw new Error('没有能放下 tank_a 的第二处远处格');
    await m.teleport('tank_a', farA.x * TILE + 5, farA.y * TILE + 5, 0);

    const evC = await m.eval('window.__vtL.resetEv()');
    const lseq = [L];
    for (let i = 0; i < 2; i++) { await m.pump(1); lseq.push(await m.eval('window.__vtL.laser()')); }
    const evAfterC = await m.eval('window.__vtEv.slice()');
    const tankBAfterC = await m.eval("(function(){var t=GameManager.getGameController().getTank('tank_b');return t?{x:t.getX(),y:t.getY()}:null;})()");
    const killedC = evAfterC.filter((e) => /kill/i.test(e.evt || ''));
    rec.control = { laserSeq: lseq.map((x) => x ? { x: x.x, y: x.y, sp: x.sp, nb: x.nb, ta: x.ta } : null),
                    tanksAlive: !!tankBAfterC, kills: killedC.length, events: evAfterC.slice(0, 6) };
    P(`  控制组（tank_b 在远处）: tank_b存活=${!!tankBAfterC} 击杀=${killedC.length} 激光${lseq.map((x) => x ? `(${x.x},${x.y})` : 'null').join('→')}`);
    if (!lseq.every((x) => x && x.nb === 0 && Math.abs(x.sp - 180) < 0.5)) throw new Error('控制帧期间激光撞墙/消失了');
    const uActCheck = { x: L.vx / L.sp, y: L.vy / L.sp };
    const runwayFwd = segmentClear({ x: L.x, y: L.y }, { x: L.x + uActCheck.x * 26, y: L.y + uActCheck.y * 26 }, openSet, 0.15);
    if (!runwayFwd) throw new Error('实际弹道前方 <26m 就撞墙（方向与预期不符：预期 dir=' + r4(spot.d.x) + ',' + r4(spot.d.y) + '，实际=' + r4(uActCheck.x) + ',' + r4(uActCheck.y) + '）');
    if (killedC.length) throw new Error('控制组就死人了：摆位/弹道有问题');
    const steps = [];
    for (let i = 1; i < lseq.length; i++) steps.push({ x: r4(lseq[i].x - lseq[i - 1].x), y: r4(lseq[i].y - lseq[i - 1].y) });
    for (const st of steps) { const Lw = vlen(st); if (Lw < 2.7 || Lw > 3.3) throw new Error('每帧位移异常 ' + Lw + 'm，激光可能撞墙'); }
    const lNow = lseq[lseq.length - 1];
    const uHat = { x: lNow.vx / lNow.sp, y: lNow.vy / lNow.sp };
    const dtEntries = await m.eval('window.__vtDtLog.map(function(e){return {f:e.f, dt:e.dt};})');
    function predictNextDt(entries) {
      const vals = entries.map((e) => Math.round(e.dt * 1e6));
      const n = vals.length;
      for (let pp = 1; pp <= Math.min(5, Math.floor(n / 2)); pp++) {
        let ok = true;
        for (let i = n - 2 * pp; i < n - pp; i++) {
          if (vals[i] === undefined || vals[i + pp] === undefined || vals[i] !== vals[i + pp]) { ok = false; break; }
        }
        if (ok) return { dt: vals[n - pp] / 1e6, period: pp, n };
      }
      return { dt: vals[n - 1] / 1e6, period: 0, n };
    }
    const predDt = predictNextDt(dtEntries);
    const dtPredInit = predDt.dt;
    const stepVInit = { x: uHat.x * 180 * dtPredInit, y: uHat.y * 180 * dtPredInit };
    const stepLenInit = vlen(stepVInit);
    rec.steps = steps; rec.predDt = predDt;
    rec.step = { x: r4(stepVInit.x), y: r4(stepVInit.y), len: r4(stepLenInit) };
    rec.dtPred = r4(dtPredInit);
    P(`  控制窗口每帧位移=${steps.map((q) => r4(vlen(q))).join(',')}m；dt日志 ${dtEntries.length} 条 周期=${predDt.period} ` +
      `；预测下一帧 dt=${r4(dtPredInit)}s ⟹ 步长=(${r4(stepVInit.x)},${r4(stepVInit.y)}) |${r4(stepLenInit)}|m`);

    const MAXCYCLE = Number(argOf('cycles', 6));
    let p0 = null, stepV = null, dtPred = null;
    for (let cyc = 0; cyc < MAXCYCLE; cyc++) {
      const Lcur = await m.eval('window.__vtL.laser()');
      const dtEntries2 = await m.eval('window.__vtDtLog.map(function(e){return {f:e.f, dt:e.dt};})');
      const pred2 = predictNextDt(dtEntries2);
      if (!Lcur || Lcur.nb > 0 || Math.abs(Lcur.sp - 180) > 0.5) {
        rec.cycles.push({ cyc, skip: '激光不在了/反弹了' });
        break;
      }
      p0 = { x: Lcur.x, y: Lcur.y };
      dtPred = pred2.dt;
      const u = { x: Lcur.vx / Lcur.sp, y: Lcur.vy / Lcur.sp };
      stepV = { x: u.x * 180 * dtPred, y: u.y * 180 * dtPred };
      const p1 = { x: p0.x + stepV.x, y: p0.y + stepV.y };
      const n = { x: -u.y, y: u.x };
      const searchRes = searchPoses(kind, { p0, p1, u, n, localPolys, openSet });
      const pose = searchRes.top[0] || null;
      const cycRec = { cyc, p0: { x: r4(p0.x), y: r4(p0.y) }, p1: { x: r4(p1.x), y: r4(p1.y) },
                       nHit: searchRes.nHit, nFit: searchRes.nFit, dtPred: r4(dtPred), dtPeriod: pred2.period,
                       candidatesTop: searchRes.top.slice(0, 4).map((c) => ({
                         thetaDeg: c.thetaDeg, sA: r4(c.sA), d: r4(c.d), score: r4(c.score), chord: r4(c.chord),
                         g05: r4(c.g05), g25: r4(c.g25), bodyHit: c.bodyHit, turretHit: c.turretHit,
                         centerDistMin: r4(c.centerDistMin)
                       })) };
      rec.cycles.push(cycRec);
      if (!pose) {
        cycRec.skip = '这个 p0 附近没有满足 ' + kind + ' 的合法摆位';
        P(`  [cycle ${cyc}] ${cycRec.skip}（几何命中 ${searchRes.nHit}/可站稳 ${searchRes.nFit}）→ 前进 1 帧再试`);
        await m.pump(1);
        continue;
      }
      cycRec.pose = { thetaDeg: pose.thetaDeg, sA: r4(pose.sA), d: r4(pose.d), C: { x: r4(pose.C.x), y: r4(pose.C.y) }, rot: r4(pose.R),
                      chord: r4(pose.chord), g05: r4(pose.g05), g25: r4(pose.g25), d0: r4(pose.d0),
                      bodyHit: pose.bodyHit, turretHit: pose.turretHit, centerDistMin: r4(pose.centerDistMin),
                      polyInfos: pose.polyInfos.map((q) => ({ maxAbsX: r4(q.maxAbsX), hit: q.hit, g05: r4(q.g05), chord: r4(q.chord) })) };
      P(`  [cycle ${cyc}] 摆位 θ=${pose.thetaDeg}° sA=${r4(pose.sA)} d=${r4(pose.d)} C=(${r4(pose.C.x)},${r4(pose.C.y)}) rot=${r4(pose.R)} ` +
        `弦长=${r4(pose.chord)} 采样gap: r0=${r4(pose.d0)} r0.05=${r4(pose.g05)} r0.25=${r4(pose.g25)} ` +
        `车体=${pose.bodyHit} 炮塔=${pose.turretHit} 最近端点离车心=${r4(pose.centerDistMin)}`);
      const sb = await m.eval(`(function(){
        var pose = ${JSON.stringify(pose.C)}; pose.rot = ${Number(pose.R)};
        var pts = ${JSON.stringify([{ x: p0.x, y: p0.y }, { x: p1.x, y: p1.y }])};
        var out = {};
        out.fused = window.__vtL.fused(pose, ${FRAMES}, ${Number(dtPred)});
        out.fused16 = window.__vtL.fused(pose, ${FRAMES}, 0.016);
        out.fused17 = window.__vtL.fused(pose, ${FRAMES}, 0.017);
        out.check = window.__vtL.check(pose, pts);
        out.track = window.__vtL.trackJudge(pose, ${FRAMES}, ${Number(dtPred)});
        out.warns = window.__vtL.warns('半径退化|扫掠|needsSweep|回退半径');
        return out;
      })()`);
      cycRec.sandbox = {
        fusedDead: sb.fused.dead, fusedDF: sb.fused.deathFrame, fusedProxMin: sb.fused.proxMin,
        fusedBulletRad: sb.fused.bulletRadUsed, fusedFallback: sb.fused.geometryFallback,
        fusedContacts: (sb.fused.contacts || []).slice(0, 3),
        fused16: { dead: sb.fused16.dead, df: sb.fused16.deathFrame },
        fused17: { dead: sb.fused17.dead, df: sb.fused17.deathFrame },
        checkDeath: sb.check,
        trackDead: sb.track.dead, trackDF: sb.track.deathFrame,
        trackDetail: sb.track.detail,
        warns: sb.warns
      };
      P(`  沙箱: checkDeath→${sb.check}; fused(dt=${r4(dtPred)}) dead=${sb.fused.dead} fd=${sb.fused.deathFrame} ` +
        `proxMin=${sb.fused.proxMin} 弹半径用=${sb.fused.bulletRadUsed} fallback=${sb.fused.geometryFallback}; ` +
        `fused@16ms=${sb.fused16.dead} fused@17ms=${sb.fused17.dead}; track dead=${sb.track.dead} fd=${sb.track.deathFrame}`);
      if (sb.warns && sb.warns.length) P(`  沙箱告警: ${JSON.stringify(sb.warns)}`);
      await m.teleport('tank_b', pose.C.x, pose.C.y, pose.R);
      const Lcheck = await m.eval('window.__vtL.laser()');
      cycRec.laserStill = Lcheck ? { x: Lcheck.x, y: Lcheck.y, nb: Lcheck.nb } : null;
      await m.eval('window.__vtL.resetEv()');
      const dtN = await m.eval('(window.__vtDtLog||[]).length');
      await m.pump(1);
      const dtNew = await m.eval('window.__vtDtLog.slice(' + dtN + ')');
      const actDt = (dtNew || []).reduce((a, e) => a + (e && e.dt ? e.dt : 0), 0);
      const actStepLen = 180 * actDt;
      const actP1 = { x: p0.x + u.x * actStepLen, y: p0.y + u.y * actStepLen };
      const actWp = worldPolysOf(localPolys, pose.C, pose.R);
      cycRec.gameDt = { entries: (dtNew || []).map((e) => ({ dtMs: Math.round(e.dt * 1000 * 1000) / 1000 })), sumMs: Math.round(actDt * 1000 * 1000) / 1000 };
      cycRec.actualGeom = {
        stepLen: r4(actStepLen), trueHit: segHitsTank(p0, actP1, actWp),
        g05: r4(Math.min(gapToTank(p0, actWp, 0.05), gapToTank(actP1, actWp, 0.05))),
        g25: r4(Math.min(gapToTank(p0, actWp, 0.25), gapToTank(actP1, actWp, 0.25))),
        chord: r4(chordOfSegment(p0, actP1, actWp))
      };
      const after = await m.eval(`(() => {
        var gc = GameManager.getGameController();
        var t = gc.getTank('tank_b');
        var ps = gc.getProjectiles(), las = null;
        for (var k in ps) { var p = ps[k]; if (p.getType() !== 0) continue;
          var b = p.getB2DBody(), v = b ? b.GetLinearVelocity() : null;
          las = { id: k, x: p.getX(), y: p.getY(), vx: v ? v.x : null, vy: v ? v.y : null, nb: p.bounces.length }; }
        return { tankB: t ? { x: t.getX(), y: t.getY(), rot: t.getRotation() } : 'DEAD/REMOVED',
                 laser: las, gcState: gc.getState(), projs: Object.keys(ps).length };
      })()`);
      const evs = await m.eval('window.__vtEv.slice()');
      const kills = evs.filter((e) => /kill/i.test(e.evt || ''));
      const deadly = evs.filter((e) => /deadly/i.test(e.evt || ''));
      cycRec.game = { tankB: after.tankB, laser: after.laser, gcState: after.gcState,
                      kills: kills.slice(0, 3), deadly: deadly.slice(0, 4), killed: kills.length > 0 };
      P(`  游戏: tank_b=${JSON.stringify(after.tankB)} 激光=${JSON.stringify(after.laser)} gc=${after.gcState}`);
      P(`  游戏事件: 击杀=${kills.length} 致命碰撞=${deadly.length} ${JSON.stringify(kills.slice(0, 1))} ${JSON.stringify(deadly.slice(0, 1))}`);
      P(`  实际下一帧: 游戏dt=${cycRec.gameDt.sumMs}ms 步长=${cycRec.actualGeom.stepLen}m 真实命中=${cycRec.actualGeom.trueHit} ` +
        `弦长=${cycRec.actualGeom.chord} 采样gap r0.05=${cycRec.actualGeom.g05} r0.25=${cycRec.actualGeom.g25}`);
      if (kills.length > 0) break;
      const Ln = await m.eval('window.__vtL.laser()');
      if (!Ln) break;
      p0 = { x: Ln.x, y: Ln.y };
      if (Ln.nb > 0 || Math.abs(Ln.sp - 180) > 0.5) break;
    }
    return rec;
  }

  /* ---- 逐 kind 跑；analytic sweep 用真实夹具多边形 ---- */
  let sweepPolys = null, sweepStepLen = 3.0, sweepPre = 3.4887;
  for (const kind of KINDS) {
    let rec = null;
    for (let att = 1; att <= MAXOPEN; att++) {
      try {
        rec = await runKind(kind, att);
        if (rec) break;
      } catch (e) {
        rec = { kind, attempt: att, err: String((e && e.stack) || e) };
        P(`  X ${kind} 第 ${att} 次失败: ${rec.err}`);
      }
      await closeM();
    }
    (OUT.trials = OUT.trials || []).push(rec);
    if (rec && rec.localPolys && rec.localPolys.length && !sweepPolys) sweepPolys = rec.localPolys.map((p) => p.map((v) => ({ x: v[0], y: v[1] })));
    if (rec && rec.meta) sweepPre = rec.meta.prefilterRadius;
    if (rec && rec.step && rec.step.len > 0) sweepStepLen = rec.step.len;
    const anyKill = rec && rec.cycles && rec.cycles.some((c) => c.game && c.game.killed);
    const anyFused = rec && rec.cycles && rec.cycles.some((c) => c.sandbox && c.sandbox.fusedDead);
    P(`\n---- ${kind} 结论: ${rec && rec.cycles && rec.cycles.length ? (anyKill ? '游戏判死' : '游戏没死') : '无结果'} / 沙箱${anyFused ? '判死' : '没死'} ----`);
    await closeM();
  }

  if (sweepPolys) {
    P('\n=== 解析扫描（点采样漏判比例；判据=线段∩真实夹具多边形） ===');
    P(`  预筛半径=${r4(sweepPre)}m；扫描 360 个方向 × 冲击参数 d∈[-5,5] 步长 0.01m（每个方向 1001 点）`);
    function runSweep(stepLen) {
      const R = stepLen / 2;
      let nAll = 0, miss05 = 0, miss25 = 0, bothOut = 0, miss05BothOut = 0, miss25BothOut = 0, prefilterScreen = 0;
      const perTheta = {};
      for (let thDeg = 0; thDeg < 360; thDeg += 1) {
        const th = thDeg * Math.PI / 180;
        const u = { x: Math.cos(th), y: Math.sin(th) };
        const nrm = { x: -u.y, y: u.x };
        let tAll = 0, tMiss05 = 0, tMiss25 = 0, tBothOut = 0, tMissBoth05 = 0, tMissBoth25 = 0;
        const wp = worldPolysOf(sweepPolys, { x: 0, y: 0 }, 0);
        for (let d = -5; d <= 5.0001; d += 0.01) {
          const segC = { x: nrm.x * d, y: nrm.y * d };
          const e0 = { x: segC.x - u.x * R, y: segC.y - u.y * R };
          const e1 = { x: segC.x + u.x * R, y: segC.y + u.y * R };
          if (!segHitsTank(e0, e1, wp)) continue;
          tAll++;
          const g05 = Math.min(gapToTank(e0, wp, 0.05), gapToTank(e1, wp, 0.05));
          const g25 = Math.min(gapToTank(e0, wp, 0.25), gapToTank(e1, wp, 0.25));
          const d0 = Math.min(gapToTank(e0, wp, 0), gapToTank(e1, wp, 0));
          if (g05 >= 0) tMiss05++;
          if (g25 >= 0) tMiss25++;
          if (d0 > 0) { tBothOut++; if (g05 >= 0) tMissBoth05++; if (g25 >= 0) tMissBoth25++; }
          if (Math.min(dist(e0, { x: 0, y: 0 }), dist(e1, { x: 0, y: 0 })) > sweepPre) prefilterScreen++;
        }
        nAll += tAll; miss05 += tMiss05; miss25 += tMiss25;
        bothOut += tBothOut; miss05BothOut += tMissBoth05; miss25BothOut += tMissBoth25;
        perTheta[thDeg] = { all: tAll, miss05: tMiss05, miss25: tMiss25, bothOut: tBothOut, missBoth05: tMissBoth05, missBoth25: tMissBoth25 };
      }
      return { stepLen, prefilter: sweepPre, nAll, miss05, miss25, bothOut,
               miss05BothOut, miss25BothOut, prefilterScreen, perTheta };
    }
    OUT.sweeps = [runSweep(sweepStepLen), runSweep(2.88), runSweep(3.0), runSweep(3.06)];
    for (const sw of OUT.sweeps) {
      P(`  > 步长=${r4(sw.stepLen)}m：真命中摆位样本 ${sw.nAll}；漏判(fused r=0.05)=${sw.miss05} (${(100 * sw.miss05 / sw.nAll).toFixed(1)}%)；` +
        `漏判(checkDeath r=0.25)=${sw.miss25} (${(100 * sw.miss25 / sw.nAll).toFixed(1)}%)；` +
        `两端在外 ${sw.bothOut} 其中漏(fused) ${sw.miss05BothOut} (${(100 * sw.miss05BothOut / Math.max(1, sw.bothOut)).toFixed(1)}%)；` +
        `预筛会筛掉 ${sw.prefilterScreen}`);
      const pick = [0, 2, 5, 10, 15, 20, 30, 45, 60, 90, 135, 180, 225, 270];
      for (const deg of pick) {
        const t = sw.perTheta[deg]; if (!t) continue;
        P(`    θ=${deg}°: 真命中 ${t.all} 漏fused ${t.miss05} 漏check ${t.miss25} 两端在外 ${t.bothOut} 其中漏fused ${t.missBoth05}`);
      }
    }
  }

  P('\n=== 结束 ===');
  try { P('  vtStats: ' + JSON.stringify(await m.stats())); } catch (e) { P('  vtStats 读不到'); }
  fs.writeFileSync(path.join(PROFDIR, 'probe_lsx_report.json'), JSON.stringify(OUT, null, 1));
  try { await m.close(); } catch (e) {}
  console.log(`\n[done] ${((Date.now() - T0) / 1000).toFixed(1)}s → prof/probe_lsx_report.json`);
})().catch((e) => {
  console.error('FATAL:', (e && e.stack) || e);
  try { fs.writeFileSync(path.join(PROFDIR, 'probe_lsx_report.json'), JSON.stringify(Object.assign({ fatal: String((e && e.stack) || e) }, OUT), null, 1)); } catch (e2) {}
  process.exitCode = 1;
});
