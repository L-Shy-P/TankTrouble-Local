#!/usr/bin/env node
/* ============================================================================
 * 1-2③ 激光扫掠 —— Rust/wasm 行为对拍（不走 cargo CLI，绕开本机缺 MSVC linker）
 *
 * 直接对 **部署的 vantage_core.wasm（ABI v11）** 调 VantageRustBridge：
 *   A) 5 个 golden 局面（真游戏实测）→ vt_rollout_batch 必须 dead=true / fd=0
 *   B) 负例：同一局面把坦克沿法线移开 1m → 必须 dead=false（防误报）
 *   C) 普通弹对照 → 仍 dead=true（防误伤非激光）
 *   D) rescore 激光：vt_rescore_nodes 的 kind=3 threat + 激光轨迹 → deathFrame>=0
 *
 * 用法：node _tools/headless/_probe_laser_sweep_wasm.js
 * 退出码：全 PASS=0，否则 1。
 * ============================================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..', '..');
const bridgePath = path.join(root, 'game_core', 'js', 'vantage_rust_bridge.js');
const wasmPath = path.join(root, 'game_core', 'js', 'wasm', 'vantage_core.wasm');
const POS_TOL = 1e-9;

const GOLDEN = [
  { name: 'full_edge',       p0: { x: 59.56, y: 15 }, p1: { x: 62.62, y: 15 }, C: { x: 61.09, y: 15 }, rot: 0 },
  { name: 'miss_almostfull', p0: { x: 49.56, y: 25 }, p1: { x: 52.62, y: 25 }, C: { x: 50.89, y: 23.15 }, rot: -0.1745 },
  { name: 'miss_oblique',    p0: { x: 59.56, y: 25 }, p1: { x: 62.62, y: 25 }, C: { x: 60.74, y: 23.25 }, rot: -0.7854 },
  { name: 'miss_corner',     p0: { x: 39.56, y: 15 }, p1: { x: 42.62, y: 15 }, C: { x: 40.69, y: 13 }, rot: -0.8727 },
  { name: 'miss_turret',     p0: { x: 59.56, y: 5 },  p1: { x: 62.62, y: 5 },  C: { x: 61.49, y: 6.9 }, rot: -0.5236 },
];

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
  return { bridge, init, version: bridge.version() };
}

function laserScene(scene, offsetNormal) {
  const ux = scene.p1.x - scene.p0.x, uy = scene.p1.y - scene.p0.y;
  const len = Math.hypot(ux, uy);
  const u = { x: ux / len, y: uy / len };
  const n = { x: -u.y, y: u.x };
  const off = offsetNormal || 0;
  return {
    startPose: { x: scene.C.x + n.x * off, y: scene.C.y + n.y * off, rot: scene.rot },
    ops: [{ speed: 0, rotationSpeed: 0 }],
    walls: [],
    bullets: [{ x: scene.p0.x, y: scene.p0.y, vx: u.x * 180, vy: u.y * 180,
                radius: 0, lifeLeft: 0.6, active: true, isLaser: true }],
    frames: 3,
    cacheId: 9000,
  };
}

(async () => {
  let fails = 0;
  const { bridge, init, version } = await loadBridge();
  console.log('=== 1-2③ Rust/wasm 激光扫掠行为对拍 ===');
  console.log('bridge init=' + JSON.stringify(init) + '  version=' + version);
  if (!init.ok || version !== 11) { console.log('FAIL 桥未就绪或 ABI != 11'); process.exitCode = 1; return; }

  console.log('\n[A] 5 个 golden 局面（vt_rollout_batch，1 op / 3 帧，isLaser=true）');
  for (let i = 0; i < GOLDEN.length; i++) {
    const s = GOLDEN[i];
    const input = laserScene(s, 0);
    const r = bridge.rolloutBatch(input);
    const ok = r && r.ok === true && r.dead[0] === true && r.deathFrame[0] === 0;
    console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + s.name.padEnd(17) +
      ' dead=' + (r && r.ok ? r.dead[0] : 'ERR') + ' fd=' + (r && r.ok ? r.deathFrame[0] : '-') +
      (r && !r.ok ? '  err=' + r.error : ''));
    if (!ok) fails++;
  }

  console.log('\n[B] 负例：弹道从坦克上方 1.0m 擦过（轴线平行，不命中）');
  {
    // 车体 3.0×4.0、rot=0 时 y∈[13,17]；激光在 y=18（净空 1.0m）→ 必须 dead=false。
    // （原负例"沿法线移 1m"对这些斜置车体仍会命中，是构造错，不是代码误报。）
    const r = bridge.rolloutBatch({
      startPose: { x: 61.09, y: 15, rot: 0 },
      ops: [{ speed: 0, rotationSpeed: 0 }],
      walls: [],
      bullets: [{ x: 59.56, y: 18, vx: 180, vy: 0, radius: 0, lifeLeft: 0.6, active: true, isLaser: true }],
      frames: 3, cacheId: 9003,
    });
    const ok = r && r.ok === true && r.dead[0] === false;
    console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  激光在车体上方 1m  dead=' + (r && r.ok ? r.dead[0] : 'ERR'));
    if (!ok) fails++;
  }

  console.log('\n[C] 普通弹对照（radius 0.25，朝坦克中心）');
  {
    const s = GOLDEN[0];
    const r = bridge.rolloutBatch({
      startPose: { x: s.C.x, y: s.C.y, rot: s.rot },
      ops: [{ speed: 0, rotationSpeed: 0 }],
      walls: [],
      bullets: [{ x: s.C.x - 1.0, y: s.C.y, vx: 18, vy: 0, radius: 0.25, lifeLeft: 5, active: true }],
      frames: 3, cacheId: 9001,
    });
    const ok = r && r.ok === true && r.dead[0] === true;
    console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  普通弹 dead=' + (r && r.ok ? r.dead[0] : 'ERR') + ' fd=' + (r && r.ok ? r.deathFrame[0] : '-'));
    if (!ok) fails++;
  }

  console.log('\n[D] rescore 激光（vt_rescore_nodes，kind=3 + 激光轨迹穿过静止坦克）');
  {
    const samples = [];
    for (let i = 0; i < 10; i++) samples.push({ x: 5, y: 5, rot: 0 });
    const track = [];
    for (let i = 0; i < 10; i++) track.push({ x: 1.0 + 3.6 * i, y: 5, alive: true });
    const node = { samples: samples, moving: false, startT: 0, frames: 9 };
    const threat = { track: track, path: [{ x: 1, y: 5 }, { x: 10, y: 5 }], speed: 180,
                     anchorOffset: 0, bulletRadius: 0, lifeLeftSeconds: 0.8, isNew: true, kind: 3 };
    const cfg = { deathPenalty: 0, stuckPenalty: 4, stuckDistEps: 0.05, stuckRotEps: 0.05,
                  lanePenaltyRatio: 0, springRopeEnabled: false, occlusionEnabled: true };
    const r = bridge.rescoreNodes({ cacheId: 9002, nodes: [node], walls: [], threats: [threat], cfg });
    const ok = r && r.ok === true && r.nodes && r.nodes[0] && r.nodes[0].ok === true &&
               r.nodes[0].deathFrame >= 0 && r.nodes[0].verifiedFrames > 0;
    console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  rescore ok=' + (r && r.ok) +
      ' deathFrame=' + (r && r.nodes && r.nodes[0] ? r.nodes[0].deathFrame : '-') +
      ' verified=' + (r && r.nodes && r.nodes[0] ? r.nodes[0].verifiedFrames : '-') +
      (r && !r.ok ? ' err=' + r.error : ''));
    if (!ok) fails++;
  }

  console.log('\n[结论] ' + (fails === 0 ? '全部 PASS（Rust/wasm 激光扫掠生效，无位置/无负例误报）' : fails + ' 项 FAIL'));
  process.exitCode = fails ? 1 : 0;
})().catch((e) => { console.error('FATAL', (e && e.stack) || e); process.exitCode = 1; });
