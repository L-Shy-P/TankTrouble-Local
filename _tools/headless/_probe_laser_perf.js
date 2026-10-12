#!/usr/bin/env node
/* ============================================================================
 * 1-2③ 收尾 ③：性能实测（部署 wasm）
 *   同一 9 op × 75 帧场景，测 vt_rollout_batch 的：
 *     A 无弹 / B 1 普通弹 / C 1 激光弹(needsSweep) / D 5 激光弹
 *   报告每次调用 ms、每 op·帧 µs、相对 A 的增量。
 *   （树 tick 的这 9 条候选路线就是它的主成本；另附 _probe_perf_paths.js 的实测）
 * ============================================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..', '..');
const bridgePath = path.join(root, 'game_core', 'js', 'vantage_rust_bridge.js');
const wasmPath = path.join(root, 'game_core', 'js', 'wasm', 'vantage_core.wasm');

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

function scene(bullets) {
  return {
    cacheId: 9200 + bullets.length,
    startPose: { x: 61.09, y: 15, rot: 0 },
    ops: [], // filled below
    frames: 75,
    walls: [],
    bullets: bullets,
  };
}
function makeOps() {
  const names = ['idle', 'fwd', 'back', 'left', 'right', 'fwdleft', 'fwdright', 'backleft', 'backright'];
  return names.map((n) => ({
    speed: n.indexOf('fwd') >= 0 ? 15.95 : (n.indexOf('back') >= 0 ? -12.8 : 0),
    rotationSpeed: n.indexOf('left') >= 0 ? -5.0 : (n.indexOf('right') >= 0 ? 5.0 : 0),
  }));
}
function laserBullet(i) {
  return { x: 59.56, y: 17.5 + i * 0.7, vx: 180, vy: 0, radius: 0, lifeLeft: 0.6, active: true, isLaser: true };
}
function normalBullet() {
  return { x: 59.56, y: 17.5, vx: 18, vy: 0, radius: 0.25, lifeLeft: 5, active: true };
}

function bench(bridge, bullets, iters) {
  const input = scene(bullets);
  input.ops = makeOps();
  for (let w = 0; w < 5; w++) bridge.rolloutBatch(input); // warmup
  const t0 = process.hrtime.bigint();
  for (let it = 0; it < iters; it++) bridge.rolloutBatch(input);
  const dtMs = Number(process.hrtime.bigint() - t0) / 1e6 / iters;
  return dtMs;
}

(async () => {
  const { bridge, init } = await loadBridge();
  if (!init.ok) { console.log('FAIL bridge init'); process.exitCode = 1; return; }
  const iters = 120;
  const rounds = 7;
  const cases = [
    ['A 无弹', []],
    ['B 1 普通弹', [normalBullet()]],
    ['C 1 激光弹', [laserBullet(0)]],
    ['D 5 激光弹', [laserBullet(0), laserBullet(1), laserBullet(2), laserBullet(3), laserBullet(4)]],
  ];
  for (const [, b] of cases) bench(bridge, b, 20);   // 预热所有 case
  const samples = cases.map(() => []);
  for (let rd = 0; rd < rounds; rd++) {
    for (let ci = 0; ci < cases.length; ci++) samples[ci].push(bench(bridge, cases[ci][1], iters));
  }
  const median = (a) => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)];
  const base = median(samples[0]);
  console.log('=== 1-2③ 性能实测（ABI v' + bridge.version() + '，9 op × 75 帧，' + rounds +
    ' 轮 × ' + iters + ' 次，取中位数）===');
  console.log('  case            ms/call   µs/op·frame   vs A(中位)');
  cases.forEach(([name], ci) => {
    const ms = median(samples[ci]);
    const us = ms * 1000 / (9 * 75);
    const rel = base > 0 ? ((ms / base - 1) * 100).toFixed(2) + '%' : '-';
    console.log('  ' + name.padEnd(14) + ms.toFixed(3).padStart(8) + '   ' +
      us.toFixed(3).padStart(12) + '   ' + rel.padStart(10));
  });
  console.log('  （每 op·帧 = 一次候选坦克的 1 帧 rollout；树 tick 会跑 9 条候选路线）');
})().catch((e) => { console.error('FATAL', (e && e.stack) || e); process.exitCode = 1; });
