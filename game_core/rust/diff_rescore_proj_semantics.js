#!/usr/bin/env node
// 阶段 1-2ab 收尾 ①：第 4 条弹体步进循环（`rescore.rs verify_death_for_node`）
// 缺 ①霰弹撞墙减命 / ②35ms 内 ≥5 反弹去抖上限 —— **是否真的改变 deathFrame 候选？**
//
// 权威版 §19.1 矩阵早就标了「rescore 无 isShrapnel」；本轮又确认它同样没有
// `is_shotgun` / `bounces`。本对拍用真 JS 生产链路（加载配方同 diff_rollout_bridge）实测：
//   场景① 霰弹撞墙后本应 0.7s 到期（长走廊，坦克在 20m 外）
//   场景② 内角夹死本应第 3 帧销毁（4x4 迷宫内角，坦克在 (2,4)）
// 对每种场景比较 3 条产物的 deathFrame：
//   rollout JS 融合（Rust 关）/ rollout wasm Rust（Rust 开）/ rescore（vt_rescore_nodes，
//   威胁 = 生产口径的 {track: JS bullet-only track, anchorOffset:0, ...}）。
//
// 结论（2026-10-11 实测，见报告 §八.1）：
//   · 生产口径（喂 track）下，rescore 的 fd 与 rollout **完全一致**（两场景都 -1）：
//     `threat_bullet_pos` 优先读 th.track，而 JS track 上一轮已落 ①/② ⇒ 轨迹在销毁帧断供，
//     rescore 根本拿不到“销毁之后”的摆位位置 ⇒ 它内部缺不缺 ①/② 不改变 fd。
//   · 反事实（把 JS 常量放宽成 AFTER=2.0 / COUNT=99）时，track 有帧，rescore 就报到
//     fd=60 / 24（与 JS 融合同帧）⇒ 证明 rescore 跟着 track 走，而不是自带 ①/②。
//   · 【已知残余缺口】只喂 `path`（无 track，折线回退）时 rescore 仍会沿折线飞过销毁点
//     （实测 59/28 vs rollout -1）。修它需要 ABI 弹种 + 让销毁状态跨帧持久，属设计变更，
//     按任务书「不修，只写 TODO」处理（见 rescore.rs verify_death_for_node 的 TODO）。
'use strict';
const fs = require('fs');
const path = require('path');
const H = require('./_diff_proj_semantics_harness.js');

// 静音 sandbox 的模块加载日志，保留本对拍自己的输出。
const realLog = console.log.bind(console);
console.log = function () {
  if (typeof arguments[0] === 'string' && arguments[0].indexOf('[Vantage') === 0) return;
  realLog.apply(null, arguments);
};

const root = path.resolve(__dirname, '..');
const rescoreSrc = fs.readFileSync(path.join(root, 'rust', 'vantage_core', 'src', 'rescore.rs'), 'utf8');
const rolloutSrc = fs.readFileSync(path.join(root, 'rust', 'vantage_core', 'src', 'rollout.rs'), 'utf8');
const sb = fs.readFileSync(path.join(root, 'js', 'vantage_sandbox.js'), 'utf8');

const FRAMES = 75, DT = 1 / 60;
const CORRIDOR_TOP = [[0, 1], [1, 1], [2, 1], [3, 1], [4, 1]];
const CFG = { deathPenalty: 0, stuckPenalty: 4.0, stuckDistEps: 0.05, stuckRotEps: 0.05,
  lanePenaltyRatio: 0, springRopeEnabled: false };

let failures = 0;
function ok(cond, msg) {
  if (cond) realLog('  ✓ ' + msg);
  else { realLog('  ✗ ' + msg); failures++; }
}

function scenes() {
  return {
    s1_real: { // ① 霰弹：撞左墙后被钳到 0.7s（≈42 帧），到不了 20m 外的坦克
      dt: DT, frames: FRAMES, maze: () => H.makeMaze(5, 4, CORRIDOR_TOP),
      bullet: { id: 's1', x: 0.8, y: 5, vx: -18, vy: 0, radius: 0.25, lifetime: 2.0, type: 2 },
      tank: { x: 20, y: 5, rot: 0 }, patch: null,
    },
    s1_cf: { // ① 反事实：AFTER=2.0（钳制退化）⇒ 弹活满 2s，会打到坦克
      dt: DT, frames: FRAMES, maze: () => H.makeMaze(5, 4, CORRIDOR_TOP),
      bullet: { id: 's1', x: 0.8, y: 5, vx: -18, vy: 0, radius: 0.25, lifetime: 2.0, type: 2 },
      tank: { x: 20, y: 5, rot: 0 }, patch: (C) => { C.SHOTGUN_LIFETIME_AFTER_MAZE_HIT = 2.0; },
    },
    s2_real: { // ② 内角夹死：每帧 2 次接触，第 3 帧 6≥5 销毁
      dt: DT, frames: FRAMES, maze: () => H.makeMaze(4, 4),
      bullet: { id: 's2', x: 0.45, y: 0.45, vx: 0, vy: 3, radius: 0.25, lifetime: 10, type: -1 },
      tank: { x: 2.0, y: 4.0, rot: 0 }, patch: null,
    },
    s2_cf: { // ② 反事实：COUNT=99 ⇒ 弹不销毁，会打到坦克
      dt: DT, frames: FRAMES, maze: () => H.makeMaze(4, 4),
      bullet: { id: 's2', x: 0.45, y: 0.45, vx: 0, vy: 3, radius: 0.25, lifetime: 10, type: -1 },
      tank: { x: 2.0, y: 4.0, rot: 0 }, patch: (C) => { C.PROJECTILE_BOUNCE_TIMEOUT_COUNT = 99; },
    },
  };
}

async function runScene(scene, pathOverride) {
  const S = H.loadSandbox();
  const Box2D = S.Box2D, Constants = S.Constants, VB = S.VantageSandbox;
  VB.setFrameDtSec(scene.dt);
  if (scene.patch) scene.patch(Constants);
  const maze = scene.maze();
  const tank = H.makeFakeTank(Box2D, scene.tank.x, scene.tank.y, scene.tank.rot);
  const p = H.makeFakeProjectile(Box2D, Constants, scene.bullet);
  const projs = {}; projs[p.id] = p;
  const adapter = VB.createAdapter(H.makeGameController(maze, tank, projs), 'p0');
  const pose = { x: scene.tank.x, y: scene.tank.y, rot: scene.tank.rot };
  const ops = []; for (let i = 0; i < 9; i++) ops.push(H.staticOp());

  // 第三条链（生产）：JS bullet-only track —— 上一轮已落 ①/②，销毁帧之后不再 push。
  const tracks = adapter.simulateBulletTracks(scene.frames, [scene.bullet.id]);
  const track = (tracks && tracks.length && tracks[0].frames) ? tracks[0].frames : null;
  const speed = Math.hypot(scene.bullet.vx, scene.bullet.vy);
  const threatTrack = track ? [{
    id: scene.bullet.id, track: track, anchorOffset: 0, speed: speed,
    bulletRadius: scene.bullet.radius, lifeLeftSeconds: scene.bullet.lifetime,
  }] : [];

  VB.setRustPhysicsEnabled(false);
  const opt = { startPose: pose, threats: threatTrack, tGlobal: 0 };
  const js = adapter.simulateTankBatch(pose, ops, scene.frames, opt);

  await H.initRust(S);
  VB.setRustPhysicsEnabled(true);
  const rust = adapter.simulateTankBatch(pose, ops, scene.frames, opt);

  const nodes = js.map((r) => ({ samples: r.samples, moving: false, startT: 0, frames: scene.frames }));
  const rsTrack = adapter.rescoreTankSamples(nodes, threatTrack, CFG);

  let rsPath = null;
  if (pathOverride && pathOverride.length >= 2) {
    const pth = [{
      id: scene.bullet.id, path: pathOverride, anchorOffset: 0, speed: speed || 1,
      bulletRadius: scene.bullet.radius, lifeLeftSeconds: scene.bullet.lifetime,
    }];
    rsPath = adapter.rescoreTankSamples(nodes, pth, CFG);
  }
  return { js, rust, rsTrack, rsPath, trackLen: track ? track.length : 0 };
}

function fd(batch) { return batch && batch.length ? batch[0].deathFrame : null; }
function allFd(batch) { return batch ? batch.map((r) => r.deathFrame) : null; }
function uniform(batch) {
  const a = allFd(batch);
  return !!a && a.every((v) => v === a[0]);
}

async function cfTrackPoints(scene) {
  const S = H.loadSandbox(); const Box2D = S.Box2D, C = S.Constants, VB = S.VantageSandbox;
  VB.setFrameDtSec(scene.dt); if (scene.patch) scene.patch(C);
  const maze = scene.maze();
  const tank = H.makeFakeTank(Box2D, scene.tank.x, scene.tank.y, scene.tank.rot);
  const p = H.makeFakeProjectile(Box2D, C, scene.bullet); const projs = {}; projs[p.id] = p;
  const ad = VB.createAdapter(H.makeGameController(maze, tank, projs), 'p0');
  const tr = ad.simulateBulletTracks(FRAMES, [scene.bullet.id]);
  return (tr && tr.length && tr[0].frames) ? tr[0].frames.map((f) => ({ x: f.x, y: f.y })) : [];
}

(async function main() {
  realLog('== ① 第4路径 rescore：缺 ①/② 是否改变 deathFrame？静态依据 ==');
  ok(rescoreSrc.indexOf('TODO(阶段1-2ab收尾)') >= 0,
    'rescore.rs verify_death_for_node 有本轮实测后的 TODO（缺 ①/② + 证据指针）');
  ok(/pub fn threat_bullet_pos[\s\S]{0,900}?if idx >= track\.len\(\) \{\s*\n\s*return None;/.test(rescoreSrc) &&
     /if !s\.alive \{\s*\n\s*return None;/.test(rescoreSrc),
    'rescore 取弹位优先读 track，且 track 越界 / alive=false 都返回 None ⇒ 轨迹断供 = 该帧不摆弹');
  ok((sb.split('pruneBounceStamps(').length - 1) >= 3 &&
     (sb.split('clampShotgunLifeLeftAfterHit').length - 1) >= 3,
    'JS track + JS 融合都带 ②粘性剪枝 / ①霰弹钳制（即 rescore 收到的 track 已含 ①/②）');
  ok(rolloutSrc.indexOf('if slots[si].is_shotgun {') >= 0 &&
     rolloutSrc.indexOf('BOUNCE_TIMEOUT_COUNT: usize = 5') >= 0,
    'rollout.rs 的 ①/② 仍在（基准路径）');

  realLog('\n== ① 数值对拍（dt=1/60, 75 帧）：rescore(track) vs rollout ==');
  const sc = scenes();
  const r = {};
  for (const name of ['s1_real', 's1_cf', 's2_real', 's2_cf']) {
    r[name] = await runScene(sc[name]);
    realLog('  [' + name + '] track=' + r[name].trackLen + ' 帧  JS fd=' + JSON.stringify(allFd(r[name].js)) +
      '  Rust fd=' + JSON.stringify(allFd(r[name].rust)) +
      '  rescore(track) fd=' + JSON.stringify(allFd(r[name].rsTrack)));
  }

  // (1) 真配置：生产口径下 rescore 与 rollout 完全一致（都是 -1 = 坦克活）
  for (const name of ['s1_real', 's2_real']) {
    const x = r[name];
    ok(uniform(x.rsTrack) && fd(x.rsTrack) === fd(x.js) && fd(x.rsTrack) === fd(x.rust),
      name + '：rescore(track) fd=' + fd(x.rsTrack) + ' == rollout JS/Rust fd=' + fd(x.js) + '/' + fd(x.rust) +
      ' ⇒ 生产口径下 fd 差异 = 0 帧');
  }
  ok(r.s1_real.trackLen > 30 && r.s1_real.trackLen < 50,
    '① 霰弹 track 在撞墙 0.7s（≈42 帧）处断供（实测 ' + r.s1_real.trackLen + ' 帧）');
  ok(r.s2_real.trackLen > 0 && r.s2_real.trackLen <= 8,
    '② 内角 track 在第 3 帧销毁后断供（实测 ' + r.s2_real.trackLen + ' 帧）');

  // (2) 反事实：track 一旦有帧，rescore 就报出与 JS 融合同帧的迟晚死亡 ⇒ 它跟着 track 走
  ok(fd(r.s1_cf.js) > 0 && fd(r.s1_cf.js) === fd(r.s1_cf.rsTrack),
    '① 反事实 AFTER=2.0：JS 融合 fd=' + fd(r.s1_cf.js) + ' == rescore(track) fd=' + fd(r.s1_cf.rsTrack) +
    ' ⇒ rescore 完全由 track 驱动');
  ok(fd(r.s2_cf.js) > 0 && fd(r.s2_cf.js) === fd(r.s2_cf.rsTrack),
    '② 反事实 COUNT=99：JS 融合 fd=' + fd(r.s2_cf.js) + ' == rescore(track) fd=' + fd(r.s2_cf.rsTrack));

  // (3) 已知残余缺口（只记录，不断言）：path-only（无 track）时 rescore 会飞过销毁点
  realLog('\n== ① 残余缺口（只记录，不算 FAIL）：path-only（折线回退，无 track）==');
  const p1 = await runScene(sc.s1_real, await cfTrackPoints(sc.s1_cf));
  const p2 = await runScene(sc.s2_real, await cfTrackPoints(sc.s2_cf));
  realLog('  [s1_real + path=cf轨迹] rollout fd=' + JSON.stringify(allFd(p1.rust)) +
    '  rescore(path) fd=' + JSON.stringify(allFd(p1.rsPath)));
  realLog('  [s2_real + path=cf轨迹] rollout fd=' + JSON.stringify(allFd(p2.rust)) +
    '  rescore(path) fd=' + JSON.stringify(allFd(p2.rsPath)));
  realLog('  ⇒ path-only 时 rescore 沿折线飞过 ①/② 销毁点；要修需 ABI 弹种 + 跨帧销毁状态（设计变更，未做）。');

  realLog('\n' + (failures === 0
    ? 'diff_rescore_proj_semantics PASS（生产口径喂 track 时 rescore fd 与 rollout 完全一致：① -1/-1、② -1/-1；' +
      '反事实证明 rescore 跟随 track；path-only 残余缺口已记录）'
    : 'diff_rescore_proj_semantics FAIL (' + failures + ')'));
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('diff_rescore_proj_semantics error:', (e && e.stack) || e); process.exit(1); });
