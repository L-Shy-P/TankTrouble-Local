'use strict';
/* ============================================================================
 * 实测探针：激光「一帧跨过坦克」时，游戏判不判死？沙箱判不判？
 *   —— 对拍实验（游戏 = 真值，沙箱 = 待验）
 *
 * 只读产品代码；本文件是【新建的探针】，不改 game_core/ 一个字节。
 *
 * 场景构造（两种，都用 match.teleport 精确摆位）：
 *   kind=turret : 激光下一帧的线段【擦过炮塔】（弦长 0.7m，炮塔宽 0.7m）
 *                 → 两个采样点与坦克几何都有 ≥0.5m 净空 ⇒ 点采样必漏
 *   kind=edge   : 激光下一帧的线段【正好跨过整个车体】（弦长 3.0m = TANK.WIDTH
 *                 = 每帧位移）→ 两个采样点落在车体两条侧边上（临界：靠半径 >0 才算中）
 *
 * 判据：
 *   - 「真实几何上应该命中」= 线段 p_k→p_{k+1} 与坦克真实夹具多边形相交
 *     （= 游戏 Box2D CCD/TOI 做的事；用游戏自己的 fixture 顶点算，不硬编码）
 *   - 「点采样会漏」= 两端采样点(圆半径 r)都不与多边形重叠（r=0.05 融合 / r=0.25 旧 checkDeath）
 *
 * 用法：node _tools/headless/_probe_laser_sweep.js [--trials=turret,edge] [--maxopen=6]
 * 产物：stdout（摘要+逐帧表）；prof/probe_ls_*.json
 * ============================================================================ */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Match } = require('./match');

const TILE = 10;
const WALL_HALF = 0.4;              // 墙厚 0.8m，以格线为中心（上一份实测：墙面在 0.4 / 9.6）
const PROFDIR = path.join(__dirname, 'prof');

/* ---------------- 版本指纹 ---------------- */
const FILES = [
  'game_core/index.html',
  'game_core/js/418577fd210ad079ea3d1e5e04050fe0.js',   // Projectile/.../Maze
  'game_core/js/b714588dc4621fe104113111ba90b1a7.js',   // Constants + B2DUtils
  'game_core/js/46989e393ad0e356ac8a0c6c53b362f9.js',   // RoundModel
  'game_core/js/82e43ebfcdffdaf490dbe79c9c119d29.js',   // RoundController
  'game_core/js/7b2ed8ad3598d7321f8f3d2b04b1eac8.js',   // Weapon/LaserWeapon/Tank
  'game_core/js/f1a5ef972c273fb89a098cb50b0f22e7.js',   // Box2D（CCD/TOI）
  'game_core/js/vantage_sandbox.js',
  'game_core/js/vantage_tree.js',
  '_tools/headless/match.js',
  '_tools/headless/clock.js',
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

/* ---------------- 页面内：采样器 + 事件总线 + 沙箱对拍入口 ---------------- */
const HELPERS = `
window.__vtEv = [];
if (!window.__vtWarnHook) {
  window.__vtWarnHook = true; window.__vtWarns = [];
  var __ow = console.warn;
  console.warn = function () {
    try { window.__vtWarns.push(Array.prototype.slice.call(arguments).join(' '));
          if (window.__vtWarns.length > 60) window.__vtWarns.shift(); } catch (e) {}
    return __ow.apply(console, arguments);
  };
}

window.__vtP = {
  on: false, rows: [],
  r: function (x) { return Math.round(x * 10000) / 10000; },
  install: function () {
    if (this._inst) return 'already';
    this._inst = true;
    var self = this;
    window.__vtAfter.push(function () {
      if (!self.on) return;
      var s = self.sample();
      if (s) self.rows.push(s);
    });
    var gc = GameManager.getGameController();
    if (!gc) return 'no-gc';
    var summarize = function (evt, data) {
      var o = { evt: evt, f: window.__vt.steps };
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
        }
      } catch (e) { o.err = String(e && e.message || e); }
      return o;
    };
    var rmodel = gc.roundController && gc.roundController.model;
    if (rmodel && rmodel.addEventListener) {
      rmodel.addEventListener(function (ctx, gid, evt, data) {
        window.__vtEv.push(Object.assign({ k: 'round' }, summarize(evt, data)));
      }, null, gc.getId());
    }
    return 'installed';
  },
  sample: function () {
    var gc = GameManager.getGameController();
    if (!gc) return null;
    var ps = gc.getProjectiles(), arr = [];
    for (var k in ps) {
      var p = ps[k], b = p.getB2DBody(), v = b ? b.GetLinearVelocity() : null;
      var rad = null;
      try { rad = b.GetFixtureList().GetShape().m_radius; } catch (eR) {}
      arr.push({ id: k, ty: p.getType(), o: p.getPlayerId(),
        x: this.r(p.getX()), y: this.r(p.getY()),
        vx: v ? this.r(v.x) : null, vy: v ? this.r(v.y) : null,
        sp: v ? this.r(v.Length()) : null, rad: rad,
        ta: this.r(p.getTimeAlive()), la: p.lifetime, nb: p.bounces.length,
        dto: p.isDeadlyToOwner() });
    }
    var tk = [], ts = gc.getTanks();
    for (var id in ts) tk.push({ id: id, x: this.r(ts[id].getX()), y: this.r(ts[id].getY()),
                                 rot: this.r(ts[id].getRotation()) });
    return { f: window.__vt.steps, t: Math.round(window.__vt.t * 100) / 100, p: arr, tk: tk };
  },
  chunk: function (from, n) { return this.rows.slice(from, from + n); },
  clear: function () { var n = this.rows.length; this.rows = []; return n; }
};

/** 读某坦克的真实夹具多边形（局部坐标）—— 判死不硬编码形状 */
window.__vtTankShape = function (pid) {
  var gc = GameManager.getGameController();
  var t = gc && gc.getTank(pid);
  if (!t) return null;
  var b = t.getB2DBody();
  if (!b) return null;
  var out = { circles: [], polys: [] };
  for (var f = b.GetFixtureList(); f; f = f.GetNext()) {
    var sh = f.GetShape();
    var ty = sh.GetType();
    if (ty === Box2D.Collision.Shapes.b2Shape.e_circleShape) {
      out.circles.push({ x: sh.m_p.x, y: sh.m_p.y, r: sh.m_radius });
    } else {
      var vs = (typeof sh.GetVertices === 'function' ? sh.GetVertices() : sh.m_vertices) || [];
      var pts = [];
      for (var i = 0; i < vs.length; i++) pts.push({ x: vs[i].x, y: vs[i].y });
      out.polys.push({ verts: pts, type: (f.GetUserData() || {}).type || null });
    }
  }
  return out;
};

/** 沙箱对拍入口（只读调用，不改产品代码） */
window.__vtSandbox = {
  a: null,
  make: function (pid) {
    this.a = VantageSandbox.createAdapter(GameManager.getGameController(), pid || 'tank_b');
    return !!this.a;
  },
  setDt: function (dt) { return this.a.setFrameDtSec(dt); },
  info: function () {
    var a = this.a;
    return { prefilterRadius: a.constants.DEATH_PREFILTER_RADIUS,
             frameDt: a.getFrameDtSec(),
             fusedEnabled: VantageSandbox.fusedEnabled() };
  },
  judge: function (state, samples, frames, dt) {
    var a = this.a;
    if (dt) a.setFrameDtSec(dt);
    var out = { dtUsed: a.getFrameDtSec(), prefilterRadius: a.constants.DEATH_PREFILTER_RADIUS };
    out.checkDeathSamples = a.checkDeath(state, samples);
    out.checkDeathSelf = a.checkDeath(state, [{ x: state.x, y: state.y }]);
    try {
      var ops = [{ inputs: { forward: false, back: false, left: false, right: false } }];
      var fused = a.simulateTankBatchJsFused(state, ops, frames,
        { startPose: state, auditPurpose: 'jsConfirm', tGlobal: 0, nowTGlobal: 0, threats: [] });
      out.fused = fused ? { dead: fused[0].dead, deathFrame: fused[0].deathFrame,
                            samples: fused[0].samples } : null;
    } catch (e) { out.fusedErr = String(e && e.stack || e); }
    var sum = null;
    try { sum = a.getLastFusedBatchSummary(); } catch (e2) {}
    if (sum) out.audit = { placements: sum.placements, contacts: sum.contacts,
                           deathFrames: sum.deathFrames, dead: sum.dead,
                           proximity: (sum.geometry && sum.geometry.proximity) || null,
                           contactList: sum.contactList || null };
    return out;
  }
};
`;

/* ---------------- Node 侧几何（用游戏自己的夹具顶点） ---------------- */
const r4 = (x) => Math.round(x * 10000) / 10000;
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
  for (let i = 0; i < poly.length; i++) {
    if (segInt(a, b, poly[i], poly[(i + 1) % poly.length])) return true;
  }
  return false;
}
function distPointSeg(p, a, b) {
  const ex = b.x - a.x, ey = b.y - a.y, el = ex * ex + ey * ey;
  let t = el > 0 ? ((p.x - a.x) * ex + (p.y - a.y) * ey) / el : 0;
  t = Math.max(0, Math.min(1, t));
  const qx = a.x + ex * t - p.x, qy = a.y + ey * t - p.y;
  return Math.sqrt(qx * qx + qy * qy);
}
function distPointPoly(p, poly) {
  if (pointInPoly(p, poly)) return 0;               // 内侧一律算 0（点采样重叠）
  let m = Infinity;
  for (let i = 0; i < poly.length; i++) m = Math.min(m, distPointSeg(p, poly[i], poly[(i + 1) % poly.length]));
  return m;
}
/** 采样点到坦克轮廓的最小距离（圆半径 r 时 gap = dist - r） */
function gapToTank(p, polys, r) {
  let m = Infinity;
  for (const poly of polys) m = Math.min(m, distPointPoly(p, poly));
  return m - r;
}
function segHitsTank(a, b, polys) { return polys.some((poly) => segHitsPoly(a, b, poly)); }

/* ---------------- 地图 / 摆位合法性 ---------------- */
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
  // 局部系里把轮廓内点栅格化（用于"整辆车不压墙"检查）
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
  const len = Math.hypot(p2.x - p1.x, p2.y - p1.y);
  const n = Math.max(2, Math.ceil(len / 0.25));
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
function rotForDir(d) { return Math.atan2(d.x, -d.y); }   // forward(rot) = (sin rot, -cos rot)
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

/* ---------------- 摆位方案 ---------------- */
/** kind=turret：激光线落在坦克局部 y=-off（炮塔内、车体外）；off=2.5 */
function planTurret(M, u, off) {
  const n = { x: -u.y, y: u.x };
  const f = { x: -n.x, y: -n.y };                 // 坦克朝 -n（炮塔指向激光线）
  return {
    localY: -off,
    M: M,
    C: { x: M.x + off * n.x, y: M.y + off * n.y },
    rot: Math.atan2(f.x, -f.y),
    n: n, u: u, f: f,
    reason: '激光线过炮塔(局部 y=' + (-off).toFixed(2) + ')，两端采样点离车体角≥' + (off - 2.0).toFixed(2) + 'm',
  };
}
/** kind=corner：激光线斜切车体的一个角（弦长≈1.0m），两端采样点离几何≥1.5m */
function planCorner(M, u, thetaRel, d, cornerLocal) {
  const dirLocal = { x: Math.cos(thetaRel), y: Math.sin(thetaRel) };
  const theta = Math.atan2(u.y, u.x) - Math.atan2(dirLocal.y, dirLocal.x);
  const nLocal = { x: -dirLocal.y, y: dirLocal.x };
  const c = Math.cos(theta), s = Math.sin(theta);
  const nWorld = { x: c * nLocal.x - s * nLocal.y, y: s * nLocal.x + c * nLocal.y };
  const cornerWorld = { x: M.x + d * nWorld.x, y: M.y + d * nWorld.y };
  const Rc = { x: c * cornerLocal.x - s * cornerLocal.y, y: s * cornerLocal.x + c * cornerLocal.y };
  return { localY: null, M: M, C: { x: cornerWorld.x - Rc.x, y: cornerWorld.y - Rc.y },
           rot: theta, n: nWorld, u: u, d: d, cornerLocal: cornerLocal,
           reason: '激光斜切局部角(' + cornerLocal.x + ',' + cornerLocal.y + ') 垂距 ' + d.toFixed(3) +
                   'm → 弦长≈' + (2 * d * Math.SQRT2).toFixed(2) + 'm' };
}
/** kind=edge：车体中心落在激光线中点 —— 两端采样点正好落在车体两条侧边上 */
function planEdge(M, u) {
  const n = { x: -u.y, y: u.x };
  const f = { x: -n.x, y: -n.y };
  return { localY: 0, M: M, C: { x: M.x, y: M.y }, rot: Math.atan2(f.x, -f.y), n: n, u: u, f: f,
           reason: '激光线过车体中心，两端采样点=车体两条侧边(弦长3.0m=每帧位移)' };
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
  const kinds = String(argOf('trials', 'turret,edge')).split(',').filter(Boolean);
  console.log('[probe] kinds=' + JSON.stringify(kinds) + ' args=' + JSON.stringify(argv));
  const MAXOPEN = Number(argOf('maxopen', 8));
  const OUT = { fingerprints: fingerprints(), trials: [], log: [] };
  const P = (s) => { console.log(s); OUT.log.push(s); };
  const T0 = Date.now();
  let m = new Match();

  P('=== 版本指纹 ===');
  for (const f of OUT.fingerprints) P(`  ${f.file}  mtime=${f.mtime}  md5=${f.md5}  bytes=${f.bytes}`);

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

  /* ============ 单个实验 ============ */
  async function runTrial(kind, attempt) {
    const rec = { kind: kind, attempt: attempt, t0: ((Date.now() - T0) / 1000).toFixed(1) };
    P(`\n============ 实验 ${kind} (第 ${attempt} 次) ============`);
    await requireRound(kind + '/pre');
    await m.eval(HELPERS);
    await m.eval('window.__vtP.install()');

    const mz = await m.maze();
    const openSet = new Set(mz.reachable.map((r) => key(r.x, r.y)));
    P(`  迷宫 ${mz.width}x${mz.height} 可达 ${mz.reachable.length}`);

    // 取受害车(tank_b)真实夹具形状
    const shape = await m.eval(`window.__vtTankShape('tank_b')`);
    rec.tankShape = shape;
    rec.localPolys = shape.polys.map((p) => p.verts);
    P(`  tank_b 夹具多边形: ${JSON.stringify(rec.localPolys.map((vs) => vs.map((v) => [r4(v.x), r4(v.y)])))}`);

    // 找发射点：可达格 × 8 方向，取最长的笔直空程
    const cands = [];
    for (const r of mz.reachable) {
      const c = { x: r.x * TILE + TILE / 2, y: r.y * TILE + TILE / 2 };
      for (const d of DIRS) {
        const run = clearRun(c, d, openSet, 60);
        if (run >= 24) {
          let o3 = 0;
          for (let ox = -1; ox <= 1; ox++) for (let oy = -1; oy <= 1; oy++)
            if (openSet.has(key(r.x + ox, r.y + oy))) o3++;
          cands.push({ c: c, d: d, run: run, tile: [r.x, r.y], open3: o3 });
        }
      }
    }
    cands.sort((a, b) => (b.open3 - a.open3) || (b.run - a.run));
    P(`  可用发射位 ${cands.length} 个（空程≥24m）；最长空程=${cands[0] ? cands[0].run : 0}m`);
    if (!cands.length) { rec.err = '这张图找不到空程≥24m 的直道'; return rec; }

    for (let ci = 0; ci < Math.min(cands.length, 8); ci++) {
      const spot = cands[ci];
      const alive = await m.eval(`(() => {
        var gc = GameManager.getGameController();
        return { gc: gc.getState(), inRound: GameModel._STATES.IN_ROUND,
                 a: !!gc.getTank('tank_a'), b: !!gc.getTank('tank_b') };
      })()`);
      if (alive.gc !== alive.inRound || !alive.a || !alive.b) {
        rec.err = 'round-ended-before-spot ' + JSON.stringify(alive);
        P('  !! ' + rec.err + ' → 交回外层重等回合');
        return rec;
      }
      rec.spot = { tile: spot.tile, dir: [r4(spot.d.x), r4(spot.d.y)], run: spot.run };
      // 给 tank_a 激光
      const gived = await m.eval(`(() => {
        var gc = GameManager.getGameController();
        var ws = LaserWeapon.createInitialWeaponState(IdGenerator.instance.gen('lw'), 'tank_a');
        gc.roundController.setWeaponState(ws);
        var w = gc.getActiveWeapon('tank_a');
        return { setType: ws.getType(), activeType: w ? w.getType() : null };
      })()`);
      rec.giveWeapon = gived;
      if (gived.activeType !== 0) { rec.err = '给激光失败 ' + JSON.stringify(gived); return rec; }

      await m.eval(`window.__vtTankId = 'tank_a'; 1`);
      await m.setControl({ fwd: false, back: false, left: false, right: false, fire: false });
      // 把 tank_b 先挪到远处（别挡道 / 别被自己的弹打死）
      const far = mz.reachable.reduce((best, r) => {
        const dd = (r.x * TILE + 5 - spot.c.x) ** 2 + (r.y * TILE + 5 - spot.c.y) ** 2;
        return dd > best.dd ? { r: r, dd: dd } : best;
      }, { r: mz.reachable[0], dd: -1 }).r;
      await m.teleport('tank_b', far.x * TILE + 5, far.y * TILE + 5, 0);
      await m.teleport('tank_a', spot.c.x, spot.c.y, rotForDir(spot.d));
      await m.pump(6);
      const a0 = await m.eval(`(() => { var t=GameManager.getGameController().getTank('tank_a'); return {x:t.getX(),y:t.getY(),rot:t.getRotation()}; })()`);
      rec.tankA0 = a0;
      P(`  tank_a @(${r4(a0.x)},${r4(a0.y)}) rot=${r4(a0.rot)}；方向=(${r4(spot.d.x)},${r4(spot.d.y)}) 空程=${spot.run}m`);

      // 开火
      const ev0 = await m.eval('window.__vtEv.length');
      await m.eval(`window.__vtP.clear(); window.__vtP.on = true;`);
      await m.setControl({ fire: true });
      await m.pump(1);
      await m.setControl({ fire: false });
      await m.pump(1);
      // 把 tank_a 也挪出这条弹道（激光撞墙后会反弹，可能回来打死自己）
      const far2 = mz.reachable.reduce((best, r) => {
        const dd = (r.x * TILE + 5 - far.x * TILE - 5) ** 2 + (r.y * TILE + 5 - far.y * TILE - 5) ** 2;
        return dd > best.dd ? { r: r, dd: dd } : best;
      }, { r: mz.reachable[0], dd: -1 }).r;
      await m.teleport('tank_a', far2.x * TILE + 5, far2.y * TILE + 5, 0);
      await m.pump(2);
      const L0 = await m.eval(`(() => {
        var gc = GameManager.getGameController(), ps = gc.getProjectiles(), out = [];
        for (var k in ps) { var p = ps[k], b = p.getB2DBody(), v = b.GetLinearVelocity();
          out.push({ id: k, ty: p.getType(), x: p.getX(), y: p.getY(), vx: v.x, vy: v.y,
                     sp: v.Length(), rad: b.GetFixtureList().GetShape().m_radius,
                     la: p.lifetime, ta: p.getTimeAlive() }); }
        return out;
      })()`);
      rec.laserSpawn = L0;
      P(`  开火后场上弹: ${JSON.stringify(L0)}`);

      let done = false, nullFrame = 0;
      for (let step = 0; step < 8; step++) {
        // 逐帧：先取当前激光位姿 → 尝试摆位 → 试验
        const L = await m.eval(`(() => {
          var gc = GameManager.getGameController(), ps = gc.getProjectiles();
          for (var k in ps) { var p = ps[k]; if (p.getType() !== 0) continue;
            var b = p.getB2DBody(), v = b.GetLinearVelocity();
            return { id: k, x: p.getX(), y: p.getY(), vx: v.x, vy: v.y, sp: v.Length(),
                     rad: b.GetFixtureList().GetShape().m_radius, ta: p.getTimeAlive(), la: p.lifetime,
                     f: window.__vt.steps }; }
          return null;
        })()`);
        if (!L) { P(`  [step ${step}] 激光已不存在（frame=${nullFrame}）`); break; }
        nullFrame = L.f;
        if (L.nb > 0) { P(`  [step ${step}] 激光已撞墙反弹(nb=${L.nb})，停止寻找摆位`); break; }
        const sp = Math.hypot(L.vx, L.vy);
        if (!(sp > 0)) { P(`  [step ${step}] 激光速度为 0，跳过`); break; }
        const u = { x: L.vx / sp, y: L.vy / sp };
        const pNow = { x: L.x, y: L.y };
        const step3 = { x: pNow.x + u.x * sp / 60, y: pNow.y + u.y * sp / 60 };   // 1/60 步长
        const M = { x: pNow.x + 1.5 * u.x, y: pNow.y + 1.5 * u.y };
        const plan = (kind === 'turret') ? planTurret(M, u, 2.5)
                   : (kind === 'corner') ? planCorner(M, u, Math.PI / 3, -0.354, { x: 1.5, y: -2.0 })
                   : planEdge(M, u);
        const polys = rec.localPolys;
        const worldPolys = polys.map((p) => toWorld(p, plan.C, plan.rot));

        const sweepHit = segHitsTank(pNow, step3, worldPolys);
        const gapK = gapToTank(pNow, worldPolys, 0.05);
        const gapK1 = gapToTank(step3, worldPolys, 0.05);
        const gapK25 = gapToTank(pNow, worldPolys, 0.25);
        const gapK125 = gapToTank(step3, worldPolys, 0.25);
        const fits = tankFits(plan.C, plan.rot, polys, openSet, 0.35);
        const segClear = segmentClear(pNow, step3, openSet, 0.15);
        const distK = gapToTank(pNow, worldPolys, 0);     // r=0 的真实距离
        const distK1 = gapToTank(step3, worldPolys, 0);
        const cleanMiss = (kind === 'edge')
          ? (Math.abs(distK) <= 0.01 && Math.abs(distK1) <= 0.01)     // edge：采样点正好落在侧边上
          : (gapK >= 0.30 && gapK1 >= 0.30);                          // turret/corner：干净漏判
        const cand = { f: L.f, cleanMiss: cleanMiss, laserAt: { x: r4(pNow.x), y: r4(pNow.y) }, laserNext: { x: r4(step3.x), y: r4(step3.y) },
                       u: [r4(u.x), r4(u.y)], plan: { C: { x: r4(plan.C.x), y: r4(plan.C.y) }, rot: r4(plan.rot), localY: plan.localY },
                       sweepHit: sweepHit, gap05_k: r4(gapK), gap05_k1: r4(gapK1),
                       dist_k: r4(distK), dist_k1: r4(distK1),
                       gap025_k: r4(gapK25), gap025_k1: r4(gapK125), fits: fits, segClear: segClear,
                       reason: plan.reason };
        P(`  [step ${step}] f=${L.f} 激光(${r4(pNow.x)},${r4(pNow.y)})→(${r4(step3.x)},${r4(step3.y)}) |v|=${r4(sp)} ` +
          `采样净空 r=0:[${r4(distK)},${r4(distK1)}] r=0.05:[${r4(gapK)},${r4(gapK1)}] r=0.25:[${r4(gapK25)},${r4(gapK125)}] ` +
          `线段∩车体=${sweepHit} 摆位可用=${fits} 弹道净空=${segClear}`);
        cand.worldPolys = worldPolys.map((pl) => pl.map((v) => [r4(v.x), r4(v.y)]));
        if (!fits || !segClear || !sweepHit || !cleanMiss) {
          rec.cand = cand;                    // 记最后一次尝试，方便诊断
          await m.pump(1);                    // ★ 必须前进一帧，否则死循环
          continue;
        }

        // ---- 就位 ----
        P(`  ★ 施工：tank_b → (${r4(plan.C.x)},${r4(plan.C.y)}) rot=${r4(plan.rot)}`);
        await m.teleport('tank_b', plan.C.x, plan.C.y, plan.rot);
        const bNow = await m.eval(`(() => { var t=GameManager.getGameController().getTank('tank_b');
          return t ? {x:t.getX(),y:t.getY(),rot:t.getRotation()} : null; })()`);
        cand.tankB = bNow;
        // ---- 沙箱判定（在游戏推进之前，同一局面） ----
        const sb = await m.eval(`(() => {
          window.__vtSandbox.make('tank_b');
          var st = ${JSON.stringify({ x: plan.C.x, y: plan.C.y, rot: plan.rot })};
          var samples = ${JSON.stringify([{ x: pNow.x, y: pNow.y }, { x: step3.x, y: step3.y }])};
          return window.__vtSandbox.judge(st, samples, 3, 1/60);
        })()`);
        cand.sandbox = sb;
        P(`  沙箱: 预筛半径=${r4(sb.prefilterRadius)} dt=${sb.dtUsed}s ` +
          `checkDeath(两采样点)=${sb.checkDeathSamples} checkDeath(车心)=${sb.checkDeathSelf} ` +
          `融合dead=${sb.fused ? sb.fused.dead : 'null'} fd=${sb.fused ? sb.fused.deathFrame : '-'}`);
        if (sb.audit) {
          const prox = Object.keys(sb.audit.proximity || {}).map((k) => ({ k: k, polyGap: sb.audit.proximity[k].polyGap, aabbGap: sb.audit.proximity[k].aabbGap, kk: sb.audit.proximity[k].k }));
          P(`  融合审计: contacts=${JSON.stringify(sb.audit.contacts)} dfs=${JSON.stringify(sb.audit.deathFrames)} dead=${JSON.stringify(sb.audit.dead)}`);
          P(`  融合审计 polyGap: ${JSON.stringify(prox)}`);
          P(`  融合审计 摆弹: ${JSON.stringify((sb.audit.placements || []).map((p) => ({ id: p.pid, active: p.active, src: p.src, x: p.x, y: p.y, vx: p.vx, vy: p.vy })))}`);
          cand.sandboxProx = prox;
        }
        cand.warns = await m.eval("(window.__vtWarns||[]).filter(function(s){return /半径退化|摆放弹药|needsSweep|扫掠/.test(s);}).slice(-6)");
        // ---- 游戏判定：推进 1 帧 ----
        await m.pump(1);
        const after = await m.eval(`(() => {
          var gc = GameManager.getGameController();
          var t = gc.getTank('tank_b');
          var ps = gc.getProjectiles(), las = null;
          for (var k in ps) { var p = ps[k]; if (p.getType() !== 0) continue;
            var b = p.getB2DBody(), v = b.GetLinearVelocity();
            las = { id: k, x: p.getX(), y: p.getY(), vx: v.x, vy: v.y, sp: v.Length(), ta: p.getTimeAlive(), nb: p.bounces.length, dto: p.isDeadlyToOwner() }; }
          return { tankB: t ? { x: t.getX(), y: t.getY(), rot: t.getRotation() } : 'DEAD/REMOVED',
                   laser: las, gcState: gc.getState(), projs: Object.keys(ps).length };
        })()`);
        const evs = await m.eval(`window.__vtEv.slice(${ev0})`);
        const kills = evs.filter((e) => /kill/i.test(e.evt || ''));
        const deadly = evs.filter((e) => /deadly/i.test(e.evt || ''));
        cand.game = { after: after, killed: kills.length > 0, victims: kills.map((e) => e.victim),
                      deadlyCollisions: deadly.slice(0, 6), evCount: evs.length };
        P(`  游戏: tank_b=${JSON.stringify(after.tankB)} 激光=${JSON.stringify(after.laser)} gcState=${after.gcState}`);
        P(`  游戏事件(击杀 ${kills.length}, 致命碰撞 ${deadly.length}): ${JSON.stringify(kills.slice(0, 3))} ${JSON.stringify(deadly.slice(0, 3))}`);
        rec.cand = cand;
        rec.frames = await (async () => {
          const rows = [];
          for (let from = 0; ; from += 200) {
            const part = await m.eval(`window.__vtP.chunk(${from}, 200)`);
            if (!Array.isArray(part) || !part.length) break;
            for (const r of part) rows.push(r);
            if (part.length < 200) break;
          }
          return rows;
        })();
        await m.eval('window.__vtP.on = false');
        done = true;
        break;
      }
      if (done) break;
      P(`  [发射位 #${ci}] 没有可用摆位，换下一个发射位`);
    }
    return rec;
  }

  try {
    for (const kind of kinds) {
      let rec = null;
      for (let att = 1; att <= MAXOPEN; att++) {
        P(`\n=== 开对局（${kind} 第 ${att} 次尝试） ===`);
        const tOpen = Date.now();
        await m.open({ humanIds: ['tank_a', 'tank_b'], aiCount: 0, vantCount: 0 });
        P(`  open 用时 ${((Date.now() - tOpen) / 1000).toFixed(1)}s，waitForRound=${JSON.stringify(m.roundWait)}`);
        try {
          rec = await runTrial(kind, att);
        } catch (e) {
          rec = { kind: kind, attempt: att, err: String((e && e.stack) || e) };
          P(`  X 实验失败: ${rec.err}`);
        }
        if (rec && rec.cand) break;                      // 拿到对拍结果
        if (rec && rec.err === '这张图找不到空程≥24m 的直道') P('  换一张图');
        await closeM();
      }
      OUT.trials.push(rec);
      P(`\n---- ${kind} 结论: ${rec && rec.cand ? (rec.cand.game.killed ? '游戏判死' : '游戏没死') : '无结果'} / ` +
        `沙箱${rec && rec.cand ? (rec.cand.sandbox.fused && rec.cand.sandbox.fused.dead ? '判死' : '没死') : '-'} ----`);
    }
    P('\n=== 事件流汇总（本局） ===');
    try {
      const all = await m.eval('window.__vtEv.slice()');
      const by = {};
      for (const e of all) by[e.evt] = (by[e.evt] || 0) + 1;
      P('  ' + JSON.stringify(by));
    } catch (e) { P('  事件汇总失败'); }
    P('  vtStats: ' + JSON.stringify(await m.stats()));
    P('  pageErrors: ' + JSON.stringify(m.pageErrors.slice(0, 4)));
  } catch (e) {
    OUT.fatal = String((e && e.stack) || e);
    console.error('FATAL:', OUT.fatal);
    process.exitCode = 1;
  } finally {
    try { fs.writeFileSync(path.join(PROFDIR, 'probe_ls_report.json'), JSON.stringify(OUT, null, 1)); } catch (e) {}
    try { await m.close(); } catch (e) {}
    console.log(`\n[done] 用时 ${((Date.now() - T0) / 1000).toFixed(1)}s  → prof/probe_ls_report.json`);
  }
})();
