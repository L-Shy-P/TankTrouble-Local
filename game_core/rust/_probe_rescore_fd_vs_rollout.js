#!/usr/bin/env node
// 探针：第 4 条弹体步进循环（rescore.rs verify_death_for_node）缺 ①/② 是否会
// 改变 vt_rescore_nodes 的死亡帧候选？对比 rescore 路径 vs rollout 路径（JS 融合 /
// wasm Rust）给出的 deathFrame。
//
// 只用真实 JS 生产链路（_diff_proj_semantics_harness 的加载配方 = diff_rollout_bridge）。
'use strict';
const H = require('./_diff_proj_semantics_harness.js');

const FRAMES = 75, DT = 1 / 60;
const CORRIDOR_TOP = [[0, 1], [1, 1], [2, 1], [3, 1], [4, 1]];

function makeScenes() {
  return {
    // ① 霰弹撞墙减命：长走廊，弹先撞左墙（帧1），本应 0.7s（≈42 帧）到期；
    //    坦克在 20m 外（普通弹 ~60 帧到）。真配置 ⇒ 坦克活。
    s1_real: {
      dt: DT, frames: FRAMES,
      maze: () => H.makeMaze(5, 4, CORRIDOR_TOP),
      bullet: { id: 's1', x: 0.8, y: 5, vx: -18, vy: 0, radius: 0.25, lifetime: 2.0, type: 2 },
      tank: { x: 20, y: 5, rot: 0 },
      patch: null,
    },
    // ① 反事实：把 AFTER 抬到 2.0（钳制退化为恒等）⇒ 弹活满 2s，会打到坦克。
    s1_cf: {
      dt: DT, frames: FRAMES,
      maze: () => H.makeMaze(5, 4, CORRIDOR_TOP),
      bullet: { id: 's1', x: 0.8, y: 5, vx: -18, vy: 0, radius: 0.25, lifetime: 2.0, type: 2 },
      tank: { x: 20, y: 5, rot: 0 },
      patch: (C) => { C.SHOTGUN_LIFETIME_AFTER_MAZE_HIT = 2.0; },
    },
    // ② 内角夹死：每帧 2 次接触 ⇒ 第 3 帧 bounces=6 ≥5 销毁；坦克在 (2,4)。
    //    已实测试验：真配置坦克活；关掉上限后第 24 帧被打死。
    s2_real: {
      dt: DT, frames: FRAMES,
      maze: () => H.makeMaze(4, 4),
      bullet: { id: 's2', x: 0.45, y: 0.45, vx: 0, vy: 3, radius: 0.25, lifetime: 10, type: -1 },
      tank: { x: 2.0, y: 4.0, rot: 0 },
      patch: null,
    },
    // ② 反事实：COUNT=99 ⇒ 弹不销毁，第 24 帧打到坦克。
    s2_cf: {
      dt: DT, frames: FRAMES,
      maze: () => H.makeMaze(4, 4),
      bullet: { id: 's2', x: 0.45, y: 0.45, vx: 0, vy: 3, radius: 0.25, lifetime: 10, type: -1 },
      tank: { x: 2.0, y: 4.0, rot: 0 },
      patch: (C) => { C.PROJECTILE_BOUNCE_TIMEOUT_COUNT = 99; },
    },
  };
}

const CFG = { deathPenalty: 0, stuckPenalty: 4.0, stuckDistEps: 0.05, stuckRotEps: 0.05,
  lanePenaltyRatio: 0, springRopeEnabled: false };

async function runScene(scene, pathOverride) {
  const S = H.loadSandbox();
  const Box2D = S.Box2D, Constants = S.Constants, VB = S.VantageSandbox;
  VB.setFrameDtSec(scene.dt);
  if (scene.patch) scene.patch(Constants);
  const maze = scene.maze();
  const tank = H.makeFakeTank(Box2D, scene.tank.x, scene.tank.y, scene.tank.rot);
  const p = H.makeFakeProjectile(Box2D, Constants, scene.bullet);
  const projs = {}; projs[p.id] = p;
  const gc = H.makeGameController(maze, tank, projs);
  const adapter = VB.createAdapter(gc, 'p0');
  const pose = { x: scene.tank.x, y: scene.tank.y, rot: scene.tank.rot };
  const ops = []; for (let i = 0; i < 9; i++) ops.push(H.staticOp());

  // 生产弹道链：JS bullet-only track（上一轮已含 ①/②）
  const tracks = adapter.simulateBulletTracks(scene.frames, [scene.bullet.id]);
  const track = (tracks && tracks.length && tracks[0].frames) ? tracks[0].frames : null;
  // 生产威胁表 = track + path（rescore 优先用 track）。这里 path 用「弹现在的位置+速度」
  // 直线起点占位（生产 path 是反射折线）；仅当专门喂 path-only 时才用 pathOverride。
  const threatTrack = track ? [{
    id: scene.bullet.id, track: track, anchorOffset: 0, speed: Math.hypot(scene.bullet.vx, scene.bullet.vy),
    bulletRadius: scene.bullet.radius, lifeLeftSeconds: scene.bullet.lifetime,
  }] : [];

  VB.setRustPhysicsEnabled(false);
  const opt = { startPose: pose, threats: threatTrack, tGlobal: 0 };
  const js = adapter.simulateTankBatch(pose, ops, scene.frames, opt);

  const bridge = await H.initRust(S);
  VB.setRustPhysicsEnabled(true);
  const rust = adapter.simulateTankBatch(pose, ops, scene.frames, opt);

  const nodes = js.map((r) => ({ samples: r.samples, moving: false, startT: 0, frames: scene.frames }));
  let rsTrack = null, rsPath = null, rsErr = null;
  try {
    rsTrack = adapter.rescoreTankSamples(nodes, threatTrack, CFG);
  } catch (e) { rsErr = String(e && e.message || e); }
  if (pathOverride) {
    const pth = [{
      id: scene.bullet.id, path: pathOverride, anchorOffset: 0,
      speed: Math.hypot(scene.bullet.vx, scene.bullet.vy) || 1,
      bulletRadius: scene.bullet.radius, lifeLeftSeconds: scene.bullet.lifetime,
    }];
    try { rsPath = adapter.rescoreTankSamples(nodes, pth, CFG); } catch (e) { rsErr = String(e && e.message || e); }
  }
  return { S, bridge, js, rust, rsTrack, rsPath, rsErr, trackLen: track ? track.length : 0,
    trackLastAlive: track ? track.length - 1 : -1 };
}

function dfs(batch) { return batch ? batch.map((r) => r.deathFrame) : null; }

(async function main() {
  console.log('=== 第4路径 rescore vs rollout: deathFrame 实测（dt=1/60, 75帧） ===');
  const scenes = makeScenes();
  const res = {};
  for (const name of ['s1_real', 's1_cf', 's2_real', 's2_cf']) {
    const r = await runScene(scenes[name]);
    res[name] = r;
    console.log('\n[' + name + '] trackLen=' + r.trackLen + ' (last alive idx=' + r.trackLastAlive + ')');
    console.log('  rollout JS  fd=' + JSON.stringify(dfs(r.js)) + ' dead=' + JSON.stringify(r.js.map((x) => x.dead)));
    console.log('  rollout Rust fd=' + JSON.stringify(dfs(r.rust)) + ' dead=' + JSON.stringify(r.rust.map((x) => x.dead)));
    console.log('  rescore(track) fd=' + JSON.stringify(dfs(r.rsTrack)) + (r.rsErr ? ' err=' + r.rsErr : ''));
    const a = dfs(r.js)[0], b = dfs(r.rust)[0], c = dfs(r.rsTrack) ? dfs(r.rsTrack)[0] : null;
    console.log('  >>> fd  JS=' + a + ' Rust=' + b + ' rescore=' + c +
      ' | rescore-Rust 差=' + (c === null ? 'n/a' : (c - b)) + ' 帧');
  }

  console.log('\n=== 路径退化探针：只喂 path（无 track）时 rescore 会不会漏掉 ①/② ===');
  // s1_path: 用 s1_cf（AFTER=2.0 反事实）的 track 点当折线，speed=18；真配置 rollout 应"活"。
  const cf1Track = res.s1_cf.trackLen ? await (async () => {
    // 重新取 s1_cf 的 track 点
    const S = H.loadSandbox(); const Box2D = S.Box2D, C = S.Constants, VB = S.VantageSandbox;
    VB.setFrameDtSec(DT); C.SHOTGUN_LIFETIME_AFTER_MAZE_HIT = 2.0;
    const sc = scenes.s1_cf; const maze = sc.maze();
    const tank = H.makeFakeTank(Box2D, sc.tank.x, sc.tank.y, sc.tank.rot);
    const p = H.makeFakeProjectile(Box2D, C, sc.bullet); const projs = {}; projs[p.id] = p;
    const ad = VB.createAdapter(H.makeGameController(maze, tank, projs), 'p0');
    const tr = ad.simulateBulletTracks(FRAMES, [sc.bullet.id]);
    return (tr && tr.length && tr[0].frames) ? tr[0].frames.map((f) => ({ x: f.x, y: f.y })) : [];
  })() : [];
  const r1p = await runScene(scenes.s1_real, cf1Track);
  console.log('[s1_real + path=cf轨迹] pathLen=' + cf1Track.length +
    ' rollout fd=' + JSON.stringify(dfs(r1p.rust)) + ' rescore(path) fd=' + JSON.stringify(dfs(r1p.rsPath)));

  const cf2Track = res.s2_cf.trackLen ? await (async () => {
    const S = H.loadSandbox(); const Box2D = S.Box2D, C = S.Constants, VB = S.VantageSandbox;
    VB.setFrameDtSec(DT); C.PROJECTILE_BOUNCE_TIMEOUT_COUNT = 99;
    const sc = scenes.s2_cf; const maze = sc.maze();
    const tank = H.makeFakeTank(Box2D, sc.tank.x, sc.tank.y, sc.tank.rot);
    const p = H.makeFakeProjectile(Box2D, C, sc.bullet); const projs = {}; projs[p.id] = p;
    const ad = VB.createAdapter(H.makeGameController(maze, tank, projs), 'p0');
    const tr = ad.simulateBulletTracks(FRAMES, [sc.bullet.id]);
    return (tr && tr.length && tr[0].frames) ? tr[0].frames.map((f) => ({ x: f.x, y: f.y })) : [];
  })() : [];
  const r2p = await runScene(scenes.s2_real, cf2Track);
  console.log('[s2_real + path=cf轨迹] pathLen=' + cf2Track.length +
    ' rollout fd=' + JSON.stringify(dfs(r2p.rust)) + ' rescore(path) fd=' + JSON.stringify(dfs(r2p.rsPath)));
})().catch((e) => { console.error('probe error:', (e && e.stack) || e); process.exit(1); });
