#!/usr/bin/env node
/* ============================================================================
 * 1-2③ N3 单位矩阵佐证（证明 N3 PASS 不是“弹没动”造出来的）
 *
 * 同一水平墙 y∈[-0.1,0.1]、同一几何：
 *   N3 = 坦克在墙上 (4,2)：直射路径从下方走，只有“撞墙→镜面反射”才可能命中；
 *   N2 = 坦克在墙下 (4,-2)：直射路径本来会命中，墙必须先把它反射走。
 *
 * 矩阵（dt=0.02；正确单位 |v|=180，错误单位 = p1-p0 的每帧位移）：
 *   1 N3 + 墙   + 正确速度 → 期望 dead=true/fd=0（反射命中）
 *   2 N3 + 无墙 + 正确速度 → 期望 dead=false    （直射不命中；证明命中确实来自墙）
 *   3 N2 + 墙   + 正确速度 → 期望 dead=false    （墙挡住）
 *   4 N2 + 无墙 + 正确速度 → 期望 dead=true     （证明弹真的飞了整步；墙是唯一区别）
 *   5 N2 + 墙   + 错误单位 → 期望 dead=false    （旧探针：弹没动，N2 是假 PASS）
 *   6 N3 + 墙   + 错误单位 → 期望 dead=false    （旧探针：N3 FAIL 的真相）
 *
 * 推理链：4=true ⇒ 弹确实从 (1.5,0.5) 飞到 (4.05,-2.05) 一整步；
 *         3=false 且 1=true ⇒ 墙把直射挡住并按反射把弹送到 (4,2)（不是“弹没动”也不是“穿墙”）。
 * ============================================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const root = path.resolve(__dirname, '..', '..');
const bridgePath = path.join(root, 'game_core', 'js', 'vantage_rust_bridge.js');
const wasmPath = path.join(root, 'game_core', 'js', 'wasm', 'vantage_core.wasm');
const WALL = [{ verts: [{ x: -2, y: -0.1 }, { x: 6, y: -0.1 }, { x: 6, y: 0.1 }, { x: -2, y: 0.1 }] }];

async function main() {
  const sb = { console: console }; sb.global = sb; const ctx = vm.createContext(sb);
  sb.WebAssembly = WebAssembly;
  sb.fetch = async () => { const b = fs.readFileSync(wasmPath); return { ok: true, arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) }; };
  vm.runInContext(fs.readFileSync(bridgePath, 'utf8'), ctx, { filename: 'vantage_rust_bridge.js' });
  const br = sb.VantageRustBridge; const init = await br.init('js/wasm/vantage_core.wasm');
  if (!init.ok) throw new Error('bridge init failed');
  const p0 = { x: 1.5, y: 0.5 }, disp = { x: 2.545584412271571, y: -2.545584412271571 };
  const vOk = { x: disp.x / 0.02, y: disp.y / 0.02 };
  const cases = [
    ['N3 + 墙   + 正确速度', { x: 4, y: 2 }, true, WALL, vOk],
    ['N3 + 无墙 + 正确速度', { x: 4, y: 2 }, false, [], vOk],
    ['N2 + 墙   + 正确速度', { x: 4, y: -2 }, false, WALL, vOk],
    ['N2 + 无墙 + 正确速度', { x: 4, y: -2 }, true, [], vOk],
    ['N2 + 墙   + 错误单位', { x: 4, y: -2 }, false, WALL, disp],
    ['N3 + 墙   + 错误单位', { x: 4, y: 2 }, false, WALL, disp],
  ];
  console.log('=== 1-2③ N3 单位矩阵（ABI v' + br.version() + '）===');
  let fails = 0;
  cases.forEach(([name, C, expectDead, walls, v], idx) => {
    const r = br.rolloutBatch({ startPose: { x: C.x, y: C.y, rot: 0 }, ops: [{ speed: 0, rotationSpeed: 0 }],
      walls: walls, bullets: [{ x: p0.x, y: p0.y, vx: v.x, vy: v.y, radius: 0, lifeLeft: 0.8, active: true, isLaser: true }],
      frames: 3, cacheId: 9400 + idx });
    const dead = r && r.ok && r.dead[0] === true, fd = r && r.ok ? r.deathFrame[0] : null;
    const ok = dead === expectDead && (expectDead ? fd === 0 : dead === false);
    if (!ok) fails++;
    console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + name + '  dead=' + dead + ' fd=' + fd + ' expect=' + expectDead + (r && !r.ok ? ' err=' + r.error : ''));
  });
  console.log('\n' + (fails ? 'N3 UNIT MATRIX FAILED (' + fails + ')' : 'N3 UNIT MATRIX PASSED (6/6)'));
  process.exitCode = fails ? 1 : 0;
}
main().catch((e) => { console.error('FATAL', (e && e.stack) || e); process.exitCode = 1; });
