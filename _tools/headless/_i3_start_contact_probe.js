#!/usr/bin/env node
'use strict';
/* ============================================================================
 * 1-3「起点即接触」根因探针（只读产品代码；本文件不改 game_core）
 *
 * 目的：回答「Rust 到底有没有在物理层漏判 起点重叠」——
 *   ① 直接走 raw ABI `VantageRustBridge.rolloutBatch`（无 JS 消费层、无融合摆位）
 *   ② 走生产链路 `adapter.simulateTankBatchScored`（当前消费层：dead = fd >= 0）
 *   ③ 用 monkey-patch 模拟 v172 以前的消费层（dead = fd > 0），看是否复现
 *      旧 audit 的「JS df=0 / Rust -1」签名
 *
 * 四类局面：中心 / 体内0.5m / 边界擦入 / 8m 外对照
 * 另加：v(m/s) vs 每帧位移（单位退化对照） matrix
 * ============================================================================ */
const H = require('../../game_core/rust/_diff_proj_semantics_harness.js');

function opsStatic() {
  const ops = [];
  for (let i = 0; i < 9; i++) ops.push(H.staticOp());
  return ops;
}
function opsRaw() { return opsStatic().map(() => ({ speed: 0, rotationSpeed: 0 })); }

function runRaw(S, cacheId, walls, pose, bullet, frames) {
  const r = S.VantageRustBridge.rolloutBatch({
    cacheId, startPose: { x: pose.x, y: pose.y, rot: pose.rot },
    ops: opsRaw(), walls, bullets: [Object.assign({}, bullet, { lifeLeft: 10, active: true })], frames
  });
  if (!r || !r.ok) return { ok: false, error: r && r.error };
  return { ok: true, dead: r.dead.map(Boolean), df: r.deathFrame.map(Number) };
}

function makeEnv(S, pose, bullet) {
  const C = S.Constants, Box2D = S.Box2D, VS = S.VantageSandbox;
  const maze = H.makeMaze(4, 3);                       // 新 maze 对象 → 新融合世界
  const tank = H.makeFakeTank(Box2D, pose.x, pose.y, pose.rot);
  const projs = {};
  if (bullet) projs.b0 = H.makeFakeProjectile(Box2D, C, Object.assign({ id: 'b0' }, bullet));
  const gc = H.makeGameController(maze, tank, projs);
  return { gc, maze };
}

function runThrough(S, pose, bullet, frames, legacyMapping) {
  const VS = S.VantageSandbox;
  const { gc, maze } = makeEnv(S, pose, bullet);
  const aiId = 'i3_' + Math.random().toString(36).slice(2, 9);
  const ad = VS.createAdapter(gc, aiId);
  const opt = { startPose: pose, threats: [], tGlobal: 0, nowTGlobal: 0,
    auditPurpose: 'jsConfirm', cfg: { deathPenalty: 0, lanePenaltyRatio: 0 } };
  const js = ad.simulateTankBatchJsFused(pose, opsStatic(), frames, opt);
  let scored = ad.simulateTankBatchScored(pose, opsStatic(), frames, opt);
  const jsDF = js ? js.map(r => r.dead ? r.deathFrame : -1) : null;
  let curDF = null, legacyDF = null, rustUsed = null;
  if (scored) {
    rustUsed = !!(scored[0] && scored[0].rustPhysics);
    curDF = scored.map(r => r.dead ? r.deathFrame : -1);
    // v172 之前 simulateTankBatchScored 的映射是 `dead: r.deathFrame > 0`
    legacyDF = scored.map(r => r.deathFrame > 0 ? r.deathFrame : -1);
  }
  const sum = ad.getLastFusedBatchSummary && ad.getLastFusedBatchSummary();
  return { jsDF, curDF, legacyDF, rustUsed, geo: sum ? !!sum.geometryFallback : null };
}

function bulletJson(y, vyMps) { return { x: 15.0, y: y, vx: 0, vy: vyMps, radius: 0.25, type: -1, lifetime: 10, lifeLeft: 10, active: true }; }

(async () => {
  const S = H.loadSandbox();
  const VS = S.VantageSandbox;
  await H.initRust(S, 'js/wasm/vantage_core.wasm');
  VS.setRustPhysicsEnabled(true);
  VS.setFrameDtSec(1 / 60);
  const pose = { x: 15, y: 15, rot: 0 };
  const walls = H.extractWallPolygons(S, H.makeMaze(4, 3));
  const F = 75;

  const cases = [
    ['center   ', bulletJson(15.00, 18)],   // 弹心 = 车心
    ['inside0.5', bulletJson(15.50, 18)],   // 弹在体内 0.5m
    ['edge-in  ', bulletJson(17.25, 18)],   // 表面离车体边约 0.15m，首步擦入
    ['edge-out ', bulletJson(17.10, 18)],   // 真正的“相切/贴边”，向外飞（+y）
    ['far-8m   ', bulletJson( 7.00, 18)],   // 对照：8m 外飞来
  ];

  console.log('=== A. raw ABI vt_rollout_batch（无 JS 消费层）===');
  let rawOut = {};
  cases.forEach(([name, b], idx) => {
    const r = runRaw(S, 31000 + idx, walls, pose, b, F);
    rawOut[name] = r;
    console.log('  ' + name + '  ok=' + r.ok + ' dead=' + JSON.stringify(r.dead) + ' df=' + JSON.stringify(r.df));
  });

  console.log('=== B. 生产链路 adapter.simulateTankBatchScored（当前消费层 dead=fd>=0）===');
  cases.forEach(([name, b]) => {
    const r = runThrough(S, pose, b, F, false);
    rawOut[name + '#through'] = r;
    console.log('  ' + name + '  jsDF=' + JSON.stringify(r.jsDF) + '  cur(rust)DF=' + JSON.stringify(r.curDF) +
      '  legacyDF(v172前映射)=' + JSON.stringify(r.legacyDF) + '  rustUsed=' + r.rustUsed + ' geo=' + r.geo);
  });

  console.log('=== C. 单位退化 2x2（证明“真正的死”不是弹没动造出来的）===');
  const unit = [
    ['overlap + v=18m/s ', bulletJson(15.00, 18), 'overlap', true],
    ['overlap + 每帧位移 ', bulletJson(15.00, 18 / 60), 'overlap', false],
    ['far     + v=18m/s ', bulletJson( 7.00, 18), 'far', true],
    ['far     + 每帧位移 ', bulletJson( 7.00, 18 / 60), 'far', false],
    ['no-bullet         ', null, 'none', false],
  ];
  unit.forEach(([name, b, kind, correctUnit], idx) => {
    const raw = b ? runRaw(S, 31200 + idx, walls, pose, b, F) : null;
    const thru = runThrough(S, pose, b, F, false);
    console.log('  ' + name + ' rawDF=' + (raw ? JSON.stringify(raw.df) : 'n/a') +
      ' cur(rust)DF=' + JSON.stringify(thru.curDF) + ' jsDF=' + JSON.stringify(thru.jsDF));
  });
})().catch(e => { console.error('FATAL', (e && e.stack) || e); process.exitCode = 1; });
