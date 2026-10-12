#!/usr/bin/env node
'use strict';
/* ============================================================================
 * 探针（只读产品代码；本文件是新建探针）：JS 融合判死 vs Rust 判死的**逐候选对拍**
 *
 *   JS 侧：adapter.simulateTankBatchJsFused(...)   （v153 有几何回溯补判 geoHit）
 *   Rust 侧：adapter.simulateTankBatchScored(...)  （树 rolloutNine 实际用的快路；无几何补判）
 *
 * 场景 = 半真实：真 Box2D（JS + Rust 各一份真实现）+ 真 B2DUtils.createMaze 迷宫 +
 *   真 VantageSandbox 摆弹/判死代码 + 真 vantage_core.wasm；
 *   坦克是 fake（与 diff_rollout_bridge.js 同款，速度公式照抄 Tank）。
 *
 * 这是【威胁富集采样】：每局随机摆 1~3 颗真弹种参数的弹，瞄向坦克并加随机横偏，
 *   所以"判死事件"密度远高于真实对局。真实对局的无偏采样见 _probe_jr_death_real.js。
 *
 * 用法：node _tools/headless/_probe_jr_death_vm.js [--n 400] [--frames 75] [--seed 12345]
 * ============================================================================ */
const H = require('../../game_core/rust/_diff_proj_semantics_harness.js');

function arg(n, d) { const i = process.argv.indexOf('--' + n); return i < 0 ? d : Number(process.argv[i + 1]); }
const N = arg('n', 200);
const FRAMES = arg('frames', 75);
const SEED = arg('seed', 20261011);

let _s = SEED >>> 0;
function rnd() { _s = (_s * 1664525 + 1013904223) >>> 0; return _s / 4294967296; }
function rr(a, b) { return a + (b - a) * rnd(); }
function pick(arr) { return arr[Math.floor(rnd() * arr.length) % arr.length]; }

// 真弹种参数（Constants 原文，单位米 / 米每秒）
const WEAPONS = [
  { name: 'BULLET',        type: -1, radius: 0.25, speed: 18.0, life: 10.0 },
  { name: 'DOUBLE_BARREL', type: 1,  radius: 0.25, speed: 18.0, life: 6.0 },
  { name: 'LASER',         type: 0,  radius: 0.0,  speed: 180.0, life: 0.8 },   // 半径 0 ⇒ 融合世界退化为 0.05
  { name: 'SHOTGUN',       type: 2,  radius: 0.1,  speed: 32.5, life: 2.0 },
  { name: 'GATLING_GUN',   type: 5,  radius: 0.1,  speed: 27.5, life: 2.0 },
  { name: 'HOMING_MISSILE',type: 3,  radius: 0.2,  speed: 18.0, life: 10.0 },
  { name: 'MINE_SHRAPNEL', type: 4,  radius: 0.1,  speed: 30.0, life: 10.0 },
];
function weaponMix() {
  const r = rnd();
  if (r < 0.40) return WEAPONS[0];
  if (r < 0.50) return WEAPONS[1];
  if (r < 0.65) return WEAPONS[2];   // LASER 15%
  if (r < 0.78) return WEAPONS[3];
  if (r < 0.88) return WEAPONS[4];
  if (r < 0.94) return WEAPONS[5];
  return WEAPONS[6];
}

(async () => {
  const S = H.loadSandbox();
  const C = S.Constants, Box2D = S.Box2D, VS = S.VantageSandbox;
  await H.initRust(S, 'js/wasm/vantage_core.wasm');
  VS.setRustPhysicsEnabled(true);
  VS.setFrameDtSec(1 / 60);

  // 记录 console.warn（Rust 回退会响亮报错——必须确认没回退）
  const warns = [];
  const _ow = console.warn;
  console.warn = function () { warns.push(Array.prototype.slice.call(arguments).join(' ').slice(0, 200)); return _ow.apply(console, arguments); };

  const OPS = VS.OPERATIONS;
  const A = { batches: 0, ops: 0, rustUsed: 0, rustFallback: 0,
    jsOnlyDead: 0, rustOnlyDead: 0, bothDead: 0, bothAlive: 0,
    dfDiffJsMinusRust: [], opNameMismatch: {},
    byWeapon: {}, scenesWithMismatch: 0, examples: [],
    geoFallbackBatches: 0, overlapNoContactBatches: 0, geoFallbackExamples: [] };
  function bump(o, k) { o[k] = (o[k] || 0) + 1; }

  const t0 = Date.now();
  for (let sc = 0; sc < N; sc++) {
    const W = pick([4, 5, 5, 6]), Hh = pick([3, 4, 4, 5]);
    const maze = H.makeMaze(W, Hh);
    // 坦克摆在迷宫内部（离墙 >=2m）
    const pose = { x: rr(3, W * 10 - 3), y: rr(3, Hh * 10 - 3), rot: rr(-Math.PI, Math.PI) };
    const tank = H.makeFakeTank(Box2D, pose.x, pose.y, pose.rot);
    const projs = {};
    const nB = 1 + Math.floor(rnd() * 3);
    const sceneBullets = [];
    for (let bi = 0; bi < nB; bi++) {
      const wpn = weaponMix();
      // 弹起点：距坦克 6~14m；瞄向坦克中心 + 横偏（50% 近失/命中带，50% 宽散布）
      const dist = rr(6, 14);
      const ang = rr(-Math.PI, Math.PI);
      const bx = pose.x + Math.cos(ang) * dist, by = pose.y + Math.sin(ang) * dist;
      const off = (rnd() < 0.5) ? rr(-1.0, 1.0) : rr(-3.0, 3.0);
      const nx = -Math.sin(ang), ny = Math.cos(ang);         // 垂直方向
      const aim = { x: pose.x + nx * off - bx, y: pose.y + ny * off - by };
      const al = Math.hypot(aim.x, aim.y) || 1;
      const sp = wpn.speed * rr(0.95, 1.05);
      const id = 'b' + bi;
      const pr = H.makeFakeProjectile(Box2D, C, {
        id: id, x: bx, y: by, vx: aim.x / al * sp, vy: aim.y / al * sp,
        radius: wpn.radius, type: wpn.type, lifetime: wpn.life, age: rr(0, wpn.life * 0.4)
      });
      projs[id] = pr;
      sceneBullets.push({ id, w: wpn.name, r: wpn.radius === 0 ? 0.05 : wpn.radius, sp: sp, d: dist, off: off });
    }
    const gc = H.makeGameController(maze, tank, projs);
    const adapter = VS.createAdapter(gc, 'jr' + sc);
    const opt = { startPose: pose, threats: [], tGlobal: 0, nowTGlobal: 0, cfg: {} };
    let js = null, rust = null, fbSum = null;
    try { js = adapter.simulateTankBatchJsFused(pose, OPS, FRAMES, Object.assign({}, opt, { auditPurpose: 'jsConfirm' })); } catch (e) { js = null; }
    try { fbSum = adapter.getLastFusedBatchSummary(); } catch (e) { fbSum = null; }   // 必须在 Rust 调用前读：Rust 内部会再跑一次 0 帧预摆位
    try { rust = adapter.simulateTankBatchScored(pose, OPS, FRAMES, Object.assign({}, opt)); } catch (e) { rust = null; }
    if (fbSum) {
      A.geoFallbackBatches = (A.geoFallbackBatches || 0) + (fbSum.geometryFallback ? 1 : 0);
      if (fbSum.overlapNoContact && fbSum.overlapNoContact.length) A.overlapNoContactBatches = (A.overlapNoContactBatches || 0) + 1;
      if (fbSum.geometryFallback) {
        if (A.geoFallbackExamples.length < 6) A.geoFallbackExamples.push({ sc, dfs: fbSum.deathFrames, contacts: (fbSum.contacts || []).length, overlapNoContact: (fbSum.overlapNoContact || []).slice(0, 3) });
      }
    }
    if (!js || js.length !== OPS.length) { A.jsFail = (A.jsFail || 0) + 1; continue; }
    if (!rust || rust.length !== OPS.length) { A.rustFallback++; continue; }
    if (!(rust[0] && rust[0].rustPhysics)) { A.rustFallback++; continue; }
    A.rustUsed++;
    let sceneHadMismatch = false;
    for (let i = 0; i < OPS.length; i++) {
      const jd = !!js[i].dead, rd = !!rust[i].dead;
      const jdf = js[i].deathFrame, rdf = rust[i].deathFrame;
      A.ops++;
      if (jd && !rd) { A.jsOnlyDead++; sceneHadMismatch = true; bump(A.opNameMismatch, OPS[i].name); }
      else if (!jd && rd) { A.rustOnlyDead++; sceneHadMismatch = true; bump(A.opNameMismatch, 'R:' + OPS[i].name); }
      else if (jd && rd) {
        A.bothDead++;
        if (jdf !== rdf) {
          A.dfDiffJsMinusRust.push(jdf - rdf);
          sceneHadMismatch = true;
          bump(A.opNameMismatch, 'D:' + OPS[i].name);
        }
      } else A.bothAlive++;
      if ((jd !== rd) || (jdf !== rdf)) {
        const key = jd !== rd ? (jd ? 'JS多判死' : 'Rust多判死') : '死亡帧不同';
        const wkey = sceneBullets.map(b => b.w).join('+');
        if (!A.byWeapon[wkey]) A.byWeapon[wkey] = {};
        A.byWeapon[wkey][key] = (A.byWeapon[wkey][key] || 0) + 1;
        if (A.examples.length < 14) {
          A.examples.push({ sc, op: OPS[i].name, jsDead: jd, jsDF: jdf, rustDead: rd, rustDF: rdf,
            pose: { x: +pose.x.toFixed(2), y: +pose.y.toFixed(2), rot: +pose.rot.toFixed(2) }, bullets: sceneBullets });
        }
      }
    }
    if (sceneHadMismatch) A.scenesWithMismatch++;
    A.batches++;
  }
  console.warn = _ow;

  const D = A.dfDiffJsMinusRust.slice().sort((a, b) => a - b);
  const sum = arr => arr.reduce((a, b) => a + b, 0);
  const F = (arr) => {
    if (!arr.length) return null;
    const a = arr.slice().sort((x, y) => x - y);
    return { n: a.length, min: a[0], p50: a[Math.floor(a.length * 0.5)], p90: a[Math.floor(a.length * 0.9)], max: a[a.length - 1], avg: +(sum(a) / a.length).toFixed(2) };
  };
  const out = {
    seed: SEED, scenesRequested: N, framesPerOp: FRAMES, opsPerBatch: OPS.length,
    frameDt: VS.getFrameDtSec ? VS.getFrameDtSec() : null,
    rustPhysEnabled: VS.rustPhysicsEnabled(), rustFrameDtCompatible: VS.rustFrameDtCompatible(),
    batchesCompared: A.batches, rustBatchesUsed: A.rustUsed, rustFallbackBatches: A.rustFallback, jsFail: A.jsFail || 0,
    candidateOps: A.ops,
    jsOnlyDead: A.jsOnlyDead, rustOnlyDead: A.rustOnlyDead, bothDead: A.bothDead, bothAlive: A.bothAlive,
    jsOnlyDead_pct_allOps: +(100 * A.jsOnlyDead / A.ops).toFixed(3),
    rustOnlyDead_pct_allOps: +(100 * A.rustOnlyDead / A.ops).toFixed(3),
    scenesWithMismatch: A.scenesWithMismatch,
    scenesWithMismatch_pct: +(100 * A.scenesWithMismatch / A.batches).toFixed(2),
    deathFrameDiff_jsMinusRust: F(A.dfDiffJsMinusRust),
    geoFallbackBatches: A.geoFallbackBatches, overlapNoContactBatches: A.overlapNoContactBatches,
    geoFallbackExamples: A.geoFallbackExamples,
    opNameMismatch: A.opNameMismatch,
    byWeapon: A.byWeapon,
    warnings: warns.slice(0, 5), warnCount: warns.length,
    examples: A.examples,
    msPerScene: +((Date.now() - t0) / A.batches).toFixed(1)
  };
  console.log(JSON.stringify(out, null, 1));
})().catch((e) => { console.error('PROBE FAIL', (e && e.stack) || e); process.exit(1); });
