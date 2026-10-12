#!/usr/bin/env node
'use strict';
/* 1-3 第 5 处：用**真 adapter**（真 checkDeath/真 death world）验证 scorePath 起点帧修复。
   假 adapter 的守卫证明控制流；本探针证明产品 checkDeath 在起点帧真的能判死。 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const H = require('../../game_core/rust/_diff_proj_semantics_harness.js');
const DT = 1 / 60;
function track(pts) { return pts.map(p => ({ x: p[0], y: p[1] })); }
function thr(pts, laser) { return { id: 'b0', track: track(pts), trackFrameDt: DT, anchorOffset: 0, speed: 9,
  path: track([pts[0], pts[pts.length - 1]]), sweep: !!laser }; }

(async () => {
  const S = H.loadSandbox();
  vm.runInContext(fs.readFileSync(path.join(H.root, 'js', 'vantage_scoring.js'), 'utf8'), S._ctx, { filename: 'vantage_scoring.js' });
  const VS = S.VantageSandbox, SC = S.VantageScoring, Box2D = S.Box2D;
  if (!SC || typeof SC.scorePath !== 'function') throw new Error('VantageScoring missing');
  const pose = { x: 15, y: 15, rot: 0 };
  const tank = H.makeFakeTank(Box2D, pose.x, pose.y, pose.rot);
  const gc = H.makeGameController(H.makeMaze(4, 3), tank, {});
  const ad = VS.createAdapter(gc, 'i3sp_real');
  const inputs = { forward: false, back: false, left: false, right: false };
  const state = { tank: pose, tGlobal: 0, nowTGlobal: 0 };
  const cfg = { deathPenalty: 9, lanePenaltyRatio: 0 };
  function run(name, threat, expectDead, expectDf) {
    const r = SC.scorePath(ad, state, inputs, 2, [threat], cfg);
    const ok = !!r && r.dead === expectDead && (!expectDead || r.deathFrame === expectDf);
    console.log((ok ? 'PASS  ' : 'FAIL  ') + name + '  dead=' + r.dead + ' df=' + r.deathFrame +
      ' pfs=' + JSON.stringify(r.perFrameScores) + '  expect=' + expectDead + '/' + expectDf);
    if (!ok) process.exitCode = 1;
  }
  // ① 普通弹：起点就在坦克中心（track[0] = 车心）
  run('contact_start_overlap(center)', thr([[15, 15], [50, 50], [50, 50]], false), true, 0);
  // ② 普通弹：起点在体内 0.5m
  run('contact_start_overlap(inside0.5)', thr([[15.5, 15], [50, 50], [50, 50]], false), true, 0);
  // ③ 对照：起点 8m 外，第 1 帧进入（track[1] = 车心）
  run('contact_hit_frame1', thr([[15, 7], [15, 15], [15, 15]], false), true, 1);
  // ④ 对照：全程 8m 外
  run('alive_far', thr([[15, 7], [15, 7], [15, 7]], false), false, -1);
  // ⑤ 激光：起点点就在车心（sweep=true；起点帧的 segments 故意为空，靠 checkDeath）
  run('laser_start_overlap(center)', thr([[15, 15], [50, 50], [50, 50]], true), true, 0);
  // ⑥ 激光：起点在车心外 20m，第 1 帧内线段穿过车心（t0→t1 线段）→ 仍按 i=1 记 fd=1
  run('laser_cross_frame1(segment)', thr([[15, 35], [15, -5], [15, -5]], true), true, 1);
})().catch(e => { console.error('FATAL', (e && e.stack) || e); process.exitCode = 1; });
