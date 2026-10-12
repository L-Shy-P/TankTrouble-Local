#!/usr/bin/env node
/* ============================================================================
 * 1-2③ 收尾 ②：激光 N2/N3 墙相关反例（自动化）
 *   N2 = 激光被墙挡住（车在墙另一侧）→ 必须 dead=false
 *   N3 = 激光同一帧撞墙镜面反射后命中坦克（激光特有）→ 必须 dead=true/fd=0
 *
 * 做法：部署 wasm 的 vt_rollout_batch（isLaser=true）+ 一份独立 JS 逐段反射
 * oracle（线段×墙最早命中 + 镜面反射 + 线段×真坦克多边形），两边逐案比对
 * dead/deathFrame。容差：判定必须一致。
 * ============================================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..', '..');
const bridgePath = path.join(root, 'game_core', 'js', 'vantage_rust_bridge.js');
const wasmPath = path.join(root, 'game_core', 'js', 'wasm', 'vantage_core.wasm');

// 水平墙：y∈[-0.1,0.1]、x∈[-2,6]。激光沿 (1,-1)/√2 斜射，撞 y=0 镜面反射成 (1,1)/√2。
// N2：坦克在墙下（入射侧远处，直射本来会命中，但墙先反射走了）→ dead=false
// N3：坦克在墙上（反射后同帧命中）→ dead=true/fd=0
function wallVerts() {
  return [
    { x: -2.0, y: -0.1 }, { x: 6.0, y: -0.1 },
    { x: 6.0, y: 0.1 }, { x: -2.0, y: 0.1 },
  ];
}

/* ---------- JS oracle：逐段反射 + 坦克多边形 ---------- */
function tankPolys(C, rot) {
  const hw = 1.5, hh = 2.0, tw = 0.35, th = 0.7, oy = -2.0;
  const c = Math.cos(rot), s = Math.sin(rot);
  const w = (p) => ({ x: C.x + c * p.x - s * p.y, y: C.y + s * p.x + c * p.y });
  const body = [w({ x: -hw, y: -hh }), w({ x: hw, y: -hh }), w({ x: hw, y: hh }), w({ x: -hw, y: hh })];
  const turret = [
    w({ x: tw, y: oy + th }), w({ x: -tw, y: oy + th }),
    w({ x: -tw, y: oy - th }), w({ x: tw, y: oy - th }),
  ];
  return [body, turret];
}
function pointIn(p, poly) {
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
  if (pointIn(a, poly) || pointIn(b, poly)) return true;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    if (segInt(a, b, poly[i], poly[j])) return true;
  }
  return false;
}
function raySegHit(origin, dir, a, b) {
  const ex = b.x - a.x, ey = b.y - a.y;
  const den = dir.x * ey - dir.y * ex;
  if (Math.abs(den) < 1e-12) return null;
  const ox = a.x - origin.x, oy = a.y - origin.y;
  const t = (ox * ey - oy * ex) / den;
  const u = (ox * dir.y - oy * dir.x) / den;
  if (t > 1e-9 && u >= 0 && u <= 1) return t;
  return null;
}
function oracleHit(tankC, tankRot, p0, p1, walls, maxSegs) {
  const d = { x: p1.x - p0.x, y: p1.y - p0.y };
  let cur = p0, remaining = Math.hypot(d.x, d.y);
  if (remaining <= 0) return segHitsPoly(p0, p1, tankPolys(tankC, tankRot)[0]) ||
    segHitsPoly(p0, p1, tankPolys(tankC, tankRot)[1]);
  let dir = { x: d.x / remaining, y: d.y / remaining };
  for (let seg = 0; seg < maxSegs; seg++) {
    let bestT = remaining, bestWall = null, bestNormal = null;
    for (const w of walls) {
      for (let i = 0, j = w.length - 1; i < w.length; j = i++) {
        const a = w[j], b = w[i];
        const t = raySegHit(cur, dir, a, b);
        if (t !== null && t < bestT) {
          bestT = t;
          const ex = b.x - a.x, ey = b.y - a.y;
          const len = Math.hypot(ex, ey);
          bestNormal = { x: -ey / len, y: ex / len };
          bestWall = { a: a, b: b };
        }
      }
    }
    const end = { x: cur.x + dir.x * bestT, y: cur.y + dir.y * bestT };
    const polys = tankPolys(tankC, tankRot);
    for (const poly of polys) {
      if (segHitsPoly(cur, end, poly)) return true;
    }
    if (!bestWall) return false;
    // 反射：d' = d - 2(d·n)n（n 取指向入射侧的方向，符号不影响）
    const dot = dir.x * bestNormal.x + dir.y * bestNormal.y;
    dir = { x: dir.x - 2 * dot * bestNormal.x, y: dir.y - 2 * dot * bestNormal.y };
    cur = end;
    remaining -= bestT;
    if (remaining <= 1e-9) return false;
  }
  return false;
}

async function loadBridge() {
  const sandbox = { console: console };
  sandbox.global = sandbox;
  const ctx = vm.createContext(sandbox);
  sandbox.WebAssembly = WebAssembly;
  sandbox.fetch = async function () {
    const bytes = fs.readFileSync(wasmPath);
    return { ok: true, arrayBuffer: async function () {
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    } };
  };
  vm.runInContext(fs.readFileSync(bridgePath, 'utf8'), ctx, { filename: 'vantage_rust_bridge.js' });
  const bridge = sandbox.VantageRustBridge;
  const init = await bridge.init('js/wasm/vantage_core.wasm');
  return { bridge, init };
}

function scene(tankC, tankRot) {
  const p0 = { x: 1.5, y: 0.5 };
  const dt = 0.02, v = 180;
  const inv = Math.SQRT1_2;
  const p1 = { x: p0.x + v * dt * inv, y: p0.y - v * dt * inv };
  return {
    name: tankC.y > 0 ? 'N3_same_frame_reflect' : 'N2_wall_blocks',
    p0: p0, p1: p1, C: tankC, rot: tankRot,
    walls: [{ verts: wallVerts() }],
    expectDead: tankC.y > 0,
  };
}

(async () => {
  const { bridge, init } = await loadBridge();
  console.log('=== 1-2③ N2/N3 激光墙反例（wasm ABI v' + bridge.version() + '） ===');
  if (!init.ok) { console.log('FAIL bridge init'); process.exitCode = 1; return; }
  let fails = 0;
  const cases = [scene({ x: 4.0, y: -2.0 }, 0), scene({ x: 4.0, y: 2.0 }, 0)];
  for (const c of cases) {
    const wallVertsFlat = c.walls[0].verts;
    const r = bridge.rolloutBatch({
      startPose: { x: c.C.x, y: c.C.y, rot: c.rot },
      ops: [{ speed: 0, rotationSpeed: 0 }],
      walls: c.walls,
      bullets: [{ x: c.p0.x, y: c.p0.y, vx: (c.p1.x - c.p0.x) / 0.02, vy: (c.p1.y - c.p0.y) / 0.02,
                  radius: 0, lifeLeft: 0.8, active: true, isLaser: true }],
      frames: 3, cacheId: 9100 + (c.expectDead ? 1 : 0),
    });
    const oracle = oracleHit(c.C, c.rot, c.p0, c.p1, [c.walls[0].verts], 4);
    const rustDead = r && r.ok === true && r.dead[0] === true;
    const rustFd = r && r.ok ? r.deathFrame[0] : null;
    const expectFd = c.expectDead ? 0 : -1;
    const ok = r && r.ok === true && rustDead === c.expectDead &&
               (c.expectDead ? rustFd === 0 : rustDead === false) && oracle === c.expectDead;
    console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + c.name.padEnd(26) +
      ' oracle=' + oracle + ' rustDead=' + rustDead + ' rustFd=' + rustFd +
      ' expect=' + c.expectDead + '/' + expectFd);
    if (!ok) fails++;
  }
  console.log('\n' + (fails ? 'N2/N3 PROBE FAILED (' + fails + ')' : 'N2/N3 PROBE PASSED (2/2)'));
  process.exitCode = fails ? 1 : 0;
})().catch((e) => { console.error('FATAL', (e && e.stack) || e); process.exitCode = 1; });
