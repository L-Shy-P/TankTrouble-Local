#!/usr/bin/env node
'use strict';
/* 1-3：起点接触边界扫描 —— 看 raw Rust 与 JS 融合在“起点是否判死”上还剩多少分歧。
   只读产品代码。用法：node _tools/headless/_i3_start_contact_sweep.js [frames] */
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
  const F = Number(process.argv[2] || 3);

  const cases = [];
  for (let dy = -0.10; dy <= 0.30001; dy += 0.05) cases.push({ name: 'top dy=' + dy.toFixed(2), x: 15.0, y: 17.25 + dy, vy: 18 });
  for (let dx = -1.6; dx <= 1.6001; dx += 0.4) cases.push({ name: 'toprow dx=' + dx.toFixed(1), x: 15.0 + dx, y: 17.15, vy: 18 });
  cases.push({ name: 'center', x: 15, y: 15, vy: 18 });
  cases.push({ name: 'inside-x', x: 16.0, y: 15, vy: 18 });
  cases.push({ name: 'corner', x: 16.40, y: 16.90, vy: 0, vx: 18 });
  cases.push({ name: 'laser-edge', x: 15.0, y: 17.25, vy: 180, laser: true });
  cases.push({ name: 'shrapnel-center', x: 15, y: 15, vy: 18, shrapnel: true });

  let rawCache = 52000, aiSeq = 0, mismatches = 0;
  const rows = [];
  for (const c of cases) {
    const bullet = { x: c.x, y: c.y, vx: c.vx || 0, vy: c.vy, radius: c.laser ? 0.0 : 0.25,
      type: c.laser ? 0 : (c.shrapnel ? 4 : -1), lifetime: 10, lifeLeft: 10, active: true, isLaser: !!c.laser, isShrapnel: !!c.shrapnel };
    const raw = S.VantageRustBridge.rolloutBatch({ cacheId: ++rawCache, startPose: pose,
      ops: staticOps().map(() => ({ speed: 0, rotationSpeed: 0 })), walls, bullets: [bullet], frames: F });
    const maze = H.makeMaze(4, 3);
    const tank = H.makeFakeTank(S.Box2D, pose.x, pose.y, pose.rot);
    const projs = { b0: H.makeFakeProjectile(S.Box2D, S.Constants, Object.assign({ id: 'b0' }, bullet)) };
    const gc = H.makeGameController(maze, tank, projs);
    const ad = VS.createAdapter(gc, 'i3s_' + (++aiSeq));
    const js = ad.simulateTankBatchJsFused(pose, staticOps(), F, { startPose: pose, threats: [], tGlobal: 0, nowTGlobal: 0, auditPurpose: 'jsConfirm', cfg: {} });
    const jdf = js.map(r => r.dead ? r.deathFrame : -1);
    const rdf = raw.dead.map((d, i) => d ? raw.deathFrame[i] : -1);
    const j0 = jdf.every(d => d === 0), r0 = rdf.every(d => d === 0);
    const ja = jdf.every(d => d === -1), ra = rdf.every(d => d === -1);
    const sameClass = (j0 === r0) && (ja === ra) && (j0 || ja || JSON.stringify(jdf) === JSON.stringify(rdf));
    if (!sameClass) mismatches++;
    rows.push({ name: c.name, jdf, rdf, sameClass });
    console.log('  ' + (sameClass ? 'OK  ' : 'DIFF') + ' ' + c.name.padEnd(16) + ' js=' + jdf[0] + ' rust=' + rdf[0]);
    if (!sameClass) console.log('MISMATCH ' + c.name + '  js=' + JSON.stringify(jdf) + ' rust=' + JSON.stringify(rdf));
  }
  const byClass = {};
  rows.forEach(r => { const k = (r.jdf[0] === 0 ? 'js0' : (r.jdf[0] === -1 ? 'jsAlive' : 'jsN')) + '|' + (r.rdf[0] === 0 ? 'r0' : (r.rdf[0] === -1 ? 'rAlive' : 'rN')); byClass[k] = (byClass[k] || 0) + 1; });
  console.log('sweep cases=' + rows.length + ' frames=' + F + ' mismatches=' + mismatches);
  console.log('class counts: ' + JSON.stringify(byClass));
  process.exitCode = mismatches ? 1 : 0;
})().catch(e => { console.error('FATAL', (e && e.stack) || e); process.exitCode = 1; });
