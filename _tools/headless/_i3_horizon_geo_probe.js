#!/usr/bin/env node
'use strict';
/* 1-3 ②「视界最后一帧口径差」定点复现（只读产品代码）
   坦克静止在 (15,15) rot=0：车体 sensor x∈[13.5,16.5], y∈[13,17]（炮塔在下方，不挡 y=15）。
   弹沿 +x 飞 18 m/s（0.3m/帧），从左侧接近车体左缘 x=13.5。
   取半径 0.25：
     frames=5, start=11.80 → S_4=13.00(间隙0.25) S_5=13.30(侵入0.05)
        ⇒ JS 在 k=5 的 geoHit 扫描补判 df=5；Rust 最后一次接触扫描只看 S_4 ⇒ 活。
     frames=5, start=11.75 → S_5=13.25（恰好相切, polyGap=0, 不是 <0）⇒ 两边都活
     frames=6, start=11.80 → 侵入发生在 S_5，Rust 在 k=5 的 Step 后会扫到 ⇒ 两边都 df=5
     frames=5, start=11.70 → S_5=13.20（间隙0.05）⇒ 两边都活 */
const H = require('../../game_core/rust/_diff_proj_semantics_harness.js');
function staticOps() { const a = []; for (let i = 0; i < 9; i++) a.push(H.staticOp()); return a; }

(async () => {
  const S = H.loadSandbox();
  const VS = S.VantageSandbox;
  await H.initRust(S, 'js/wasm/vantage_core.wasm');
  VS.setRustPhysicsEnabled(true);
  VS.setFrameDtSec(1 / 60);
  const pose = { x: 15, y: 15, rot: 0 };
  const walls = H.extractWallPolygons(S, H.makeMaze(4, 3));
  let cache = 61000, ai = 0;

  function run(name, frames, startX, vx) {
    const bullet = { x: startX, y: 15, vx: vx, vy: 0, radius: 0.25, type: -1, lifetime: 10, lifeLeft: 10, active: true };
    const raw = S.VantageRustBridge.rolloutBatch({ cacheId: ++cache, startPose: pose,
      ops: staticOps().map(() => ({ speed: 0, rotationSpeed: 0 })), walls, bullets: [bullet], frames });
    const maze = H.makeMaze(4, 3);
    const tank = H.makeFakeTank(S.Box2D, pose.x, pose.y, pose.rot);
    const projs = { b0: H.makeFakeProjectile(S.Box2D, S.Constants, Object.assign({ id: 'b0' }, bullet)) };
    const gc = H.makeGameController(maze, tank, projs);
    const ad = VS.createAdapter(gc, 'i3h_' + (++ai));
    const opt = { startPose: pose, threats: [], tGlobal: 0, nowTGlobal: 0, auditPurpose: 'jsConfirm', cfg: { deathPenalty: 0, lanePenaltyRatio: 0 } };
    const js = ad.simulateTankBatchJsFused(pose, staticOps(), frames, opt);
    // ⚠️ 必须在 scored 之前读：scored 内部会再跑一次 simulateFusedBatch(0帧)，覆盖掉 summary
    const sum = ad.getLastFusedBatchSummary && ad.getLastFusedBatchSummary();
    const scored = ad.simulateTankBatchScored(pose, staticOps(), frames, opt);
    const jdf = js.map(r => r.dead ? r.deathFrame : -1);
    const rdf = raw.dead.map((d, i) => d ? raw.deathFrame[i] : -1);
    const sdf = scored ? scored.map(r => r.dead ? r.deathFrame : -1) : null;
    // 弹心解析位置（无墙、纯运动）：S_k = startX + k*0.3
    console.log(JSON.stringify({ name, frames, startX,
      S_last: +(startX + frames * 0.3).toFixed(4),
      jdf: jdf[0], rustDF: rdf[0], scoredDF: sdf ? sdf[0] : null,
      geoFallback: sum ? !!sum.geometryFallback : null,
      contacts: sum && sum.contacts ? sum.contacts : null }));
  }

  console.log('--- ② 视界最后一帧：JS geoHit 能补到 k=durationFrames，Rust 不能 ---');
  run('A_horizon_only_at_last_sample', 5, 11.80, 18);
  run('B_control_exact_tangent     ', 5, 11.75, 18);
  run('C_control_one_more_step     ', 6, 11.80, 18);
  run('D_control_gap_0.05          ', 5, 11.70, 18);
})().catch(e => { console.error('FATAL', (e && e.stack) || e); process.exitCode = 1; });
