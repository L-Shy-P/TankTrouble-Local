'use strict';
/* ============================================================================
 * _lfd_ 激光帧号差诊断（只读产品代码；本文件是新建探针）
 *
 * 复刻 `_probe_jr_death_vm.js` 的 VM600 场景（seed=20261011, N=600, frames=75,
 * dt=1/60），只针对【两边都判死但 deathFrame 不同】的 op 收集：
 *   jsDF / rustDF / diff / jsSweepHit(fbSum.sweepHits[i]) / 武器 / 场景
 * 并检验假设：
 *   JS 的 sweep 回溯是 `if (!dead[i] && sweepHit[i]>=0)`（fallback，已有接触就不覆盖）
 *   Rust 的 sweep 合并是 `if (sweep_hit>=0 && (death_frame<0 || sweep_hit<death_frame))`
 *   （取 min）
 *   ⟹ 两边都死时：Rust 报 sweep 帧，JS 报接触帧（更晚）。
 *
 * 用法：
 *   node _tools/headless/_lfd_frame_diff_probe.js [--n 600] [--seed 20261011] [--frozen v172]
 *   --frozen v172  用 _backup/12d_missile_20261013/vantage_sandbox.js（md5 06971cc0，v172）
 *   --frozen <path> 用指定 sandbox 文件（readFileSync 钩子，不落盘、不改产品代码）
 * ============================================================================ */
const fs = require('fs');
const path = require('path');
const H = require('../../game_core/rust/_diff_proj_semantics_harness.js');

function arg(n, d) { const i = process.argv.indexOf('--' + n); return i < 0 ? d : process.argv[i + 1]; }
const N = Number(arg('n', 600));
const FRAMES = Number(arg('frames', 75));
const SEED = Number(arg('seed', 20261011));
const FROZEN = arg('frozen', null);
const DT = Number(arg('dt', 1 / 60));
const FROZEN_PATH = FROZEN === 'v172'
  ? path.resolve(__dirname, '..', '..', '_backup', '12d_missile_20261013', 'vantage_sandbox.js')
  : (FROZEN && FROZEN !== 'none' ? path.resolve(FROZEN) : null);

let _s = SEED >>> 0;
function rnd() { _s = (_s * 1664525 + 1013904223) >>> 0; return _s / 4294967296; }
function rr(a, b) { return a + (b - a) * rnd(); }
function pick(arr) { return arr[Math.floor(rnd() * arr.length) % arr.length]; }

const WEAPONS = [
  { name: 'BULLET', type: -1, radius: 0.25, speed: 18.0, life: 10.0 },
  { name: 'DOUBLE_BARREL', type: 1, radius: 0.25, speed: 18.0, life: 6.0 },
  { name: 'LASER', type: 0, radius: 0.0, speed: 180.0, life: 0.8 },
  { name: 'SHOTGUN', type: 2, radius: 0.1, speed: 32.5, life: 2.0 },
  { name: 'GATLING_GUN', type: 5, radius: 0.1, speed: 27.5, life: 2.0 },
  { name: 'HOMING_MISSILE', type: 3, radius: 0.2, speed: 18.0, life: 10.0 },
  { name: 'MINE_SHRAPNEL', type: 4, radius: 0.1, speed: 30.0, life: 10.0 },
];
function weaponMix() {
  const r = rnd();
  if (r < 0.40) return WEAPONS[0];
  if (r < 0.50) return WEAPONS[1];
  if (r < 0.65) return WEAPONS[2];
  if (r < 0.78) return WEAPONS[3];
  if (r < 0.88) return WEAPONS[4];
  if (r < 0.94) return WEAPONS[5];
  return WEAPONS[6];
}

function loadSandboxMaybeFrozen() {
  if (!FROZEN_PATH) return H.loadSandbox();
  const orig = fs.readFileSync;
  fs.readFileSync = function (p, ...rest) {
    if (typeof p === 'string' && p.indexOf('vantage_sandbox.js') >= 0) {
      return orig.call(fs, FROZEN_PATH, ...rest);
    }
    return orig.call(fs, p, ...rest);
  };
  try { return H.loadSandbox(); } finally { fs.readFileSync = orig; }
}

function pct(a, p) { const b = a.slice().sort((x, y) => x - y); return b.length ? b[Math.min(b.length - 1, Math.floor(b.length * p))] : null; }

(async () => {
  const sandboxMd5 = require('crypto').createHash('md5')
    .update(fs.readFileSync(FROZEN_PATH || path.join(__dirname, '..', '..', 'game_core', 'js', 'vantage_sandbox.js'))).digest('hex');
  console.log('=== _lfd_ frame-diff probe ===');
  console.log('sandbox=' + (FROZEN_PATH ? FROZEN_PATH : 'game_core/js/vantage_sandbox.js') + '  md5=' + sandboxMd5 + '  dt=' + DT);
  const S = loadSandboxMaybeFrozen();
  const C = S.Constants, Box2D = S.Box2D, VS = S.VantageSandbox;
  await H.initRust(S, 'js/wasm/vantage_core.wasm');
  VS.setRustPhysicsEnabled(true);
  VS.setFrameDtSec(DT);

  const warns = [];
  const _ow = console.warn;
  console.warn = function () { warns.push(Array.prototype.slice.call(arguments).join(' ').slice(0, 160)); return _ow.apply(console, arguments); };

  const OPS = VS.OPERATIONS;
  const rows = [];
  let batches = 0, rustUsed = 0, rustFallback = 0, jsFail = 0;
  let bothDead = 0, diverged = 0, noSweep = 0;
  let jsOnly = 0, rustOnly = 0, bothAlive = 0, bothDeadSame = 0, posDiff = 0, negDiff = 0;
  let jsOnlyGeoAtJdf = 0, rustOnlyWithGeo = 0, negDiffGeoAtJdf = 0, geoEventOps = 0;
  const jsOnlyRows = [], rustOnlyRows = [], negRows = [];
  const diffs = [];
  const conv = { rustEqSweep: 0, jsEqSweep: 0, sweepLtJs: 0, sweepGtJs: 0, sweepMissing: 0, sweepNotEqual: 0 };
  const nonLaserDiv = [];
  const t0 = Date.now();
  for (let sc = 0; sc < N; sc++) {
    const W = pick([4, 5, 5, 6]), Hh = pick([3, 4, 4, 5]);
    const maze = H.makeMaze(W, Hh);
    const pose = { x: rr(3, W * 10 - 3), y: rr(3, Hh * 10 - 3), rot: rr(-Math.PI, Math.PI) };
    const tank = H.makeFakeTank(Box2D, pose.x, pose.y, pose.rot);
    const projs = {};
    const nB = 1 + Math.floor(rnd() * 3);
    const sceneBullets = [];
    for (let bi = 0; bi < nB; bi++) {
      const wpn = weaponMix();
      const dist = rr(6, 14);
      const ang = rr(-Math.PI, Math.PI);
      const bx = pose.x + Math.cos(ang) * dist, by = pose.y + Math.sin(ang) * dist;
      const off = (rnd() < 0.5) ? rr(-1.0, 1.0) : rr(-3.0, 3.0);
      const nx = -Math.sin(ang), ny = Math.cos(ang);
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
    const adapter = VS.createAdapter(gc, 'lfd' + sc);
    const opt = { startPose: pose, threats: [], tGlobal: 0, nowTGlobal: 0, cfg: {} };
    let js = null, rust = null, fb = null;
    try { js = adapter.simulateTankBatchJsFused(pose, OPS, FRAMES, Object.assign({}, opt, { auditPurpose: 'jsConfirm' })); } catch (e) { js = null; }
    try { fb = adapter.getLastFusedBatchSummary(); } catch (e) { fb = null; }
    try { rust = adapter.simulateTankBatchScored(pose, OPS, FRAMES, Object.assign({}, opt)); } catch (e) { rust = null; }
    if (!js || js.length !== OPS.length) { jsFail++; continue; }
    if (!rust || rust.length !== OPS.length || !(rust[0] && rust[0].rustPhysics)) { rustFallback++; continue; }
    rustUsed++; batches++;
    for (let i = 0; i < OPS.length; i++) {
      const jd = !!js[i].dead, rd = !!rust[i].dead;
      const jdf = js[i].deathFrame, rdf = rust[i].deathFrame;
      const opContacts = (fb && fb.contacts) ? fb.contacts.filter((c) => c.op === i) : [];
      const geoEvents = opContacts.filter((c) => c.category === 'geometry' || c.source === 'polyGap-scan');
      if (geoEvents.length) geoEventOps++;
      const geoAtJdf = geoEvents.some((c) => c.k === jdf);
      if (jd && !rd) {
        jsOnly++;
        if (geoAtJdf) jsOnlyGeoAtJdf++;
        if (jsOnlyRows.length < 12) jsOnlyRows.push({ sc: sc, op: OPS[i].name, i: i, jdf: jdf, geoAtJdf: geoAtJdf,
          geoEvents: geoEvents.slice(0, 4), sweepHit: (fb && fb.sweepHits) ? fb.sweepHits[i] : null, bullets: sceneBullets });
        continue;
      }
      if (!jd && rd) {
        rustOnly++;
        if (geoEvents.length) rustOnlyWithGeo++;
        if (rustOnlyRows.length < 12) rustOnlyRows.push({ sc: sc, op: OPS[i].name, i: i, rdf: rdf,
          geoEvents: geoEvents.slice(0, 4), bullets: sceneBullets });
        continue;
      }
      if (!jd && !rd) { bothAlive++; continue; }
      bothDead++;
      if (jdf === rdf) { bothDeadSame++; continue; }
      if (jdf < rdf) {
        negDiff++;
        if (geoAtJdf) negDiffGeoAtJdf++;
        if (negRows.length < 12) negRows.push({ sc: sc, op: OPS[i].name, i: i, jdf: jdf, rdf: rdf, diff: jdf - rdf,
          geoAtJdf: geoAtJdf, geoEvents: geoEvents.slice(0, 4), sweepHit: (fb && fb.sweepHits) ? fb.sweepHits[i] : null, bullets: sceneBullets });
      } else {
        posDiff++;
      }
      diverged++;
      diffs.push(jdf - rdf);
      const jsSweep = (fb && fb.sweepHits) ? fb.sweepHits[i] : null;
      if (jsSweep === null || jsSweep === undefined || jsSweep < 0) conv.sweepMissing++;
      else {
        if (jsSweep === rdf) conv.rustEqSweep++;
        if (jsSweep === jdf) conv.jsEqSweep++;
        if (jsSweep < jdf) conv.sweepLtJs++;
        if (jsSweep > jdf) conv.sweepGtJs++;
        if (jsSweep !== rdf) conv.sweepNotEqual++;
      }
      const hasLaser = sceneBullets.some((b) => b.w === 'LASER');
      if (!hasLaser) nonLaserDiv.push({ sc, op: OPS[i].name, jdf, rdf, bullets: sceneBullets });
      const nonSweepKs = opContacts.filter((c) => c.category !== 'sweep').map((c) => c.k);
      const minNonSweep = nonSweepKs.length ? Math.min.apply(null, nonSweepKs) : null;
      const differentBullet = opContacts.some((c) => c.category !== 'sweep' && c.bullet && c.bullet.r > 0.06);
      if (minNonSweep === jdf) conv.jsEqMinNonSweep = (conv.jsEqMinNonSweep || 0) + 1;
      if (minNonSweep === null) conv.minNonSweepMissing = (conv.minNonSweepMissing || 0) + 1;
      if (differentBullet) conv.differentBullet = (conv.differentBullet || 0) + 1;
      rows.push({ sc, op: OPS[i].name, i, jdf, rdf, diff: jdf - rdf, jsSweep, minNonSweep: minNonSweep, differentBullet: differentBullet, contactN: opContacts.length,
        jsSweepHit: (fb && fb.sweepHits) ? fb.sweepHits[i] : null,
        geoFallback: !!(fb && fb.geometryFallback), sweepFallback: !!(fb && fb.sweepFallback),
        pose: { x: +pose.x.toFixed(2), y: +pose.y.toFixed(2), rot: +pose.rot.toFixed(2) },
        bullets: sceneBullets });
    }
  }
  console.warn = _ow;
  const top = rows.slice().sort((a, b) => b.diff - a.diff).slice(0, 6);
  console.log('batches=' + batches + ' rustUsed=' + rustUsed + ' rustFallback=' + rustFallback + ' jsFail=' + jsFail + ' warns=' + warns.length);
  console.log('bothDead=' + bothDead + ' diverged=' + diverged + ' (' + (100 * diverged / Math.max(1, bothDead)).toFixed(1) + '%)');
  console.log('diff js-rust: min=' + (diffs.length ? Math.min(...diffs) : '-') +
    ' p50=' + pct(diffs, 0.5) + ' p90=' + pct(diffs, 0.9) + ' max=' + (diffs.length ? Math.max(...diffs) : '-'));
  console.log('convergence: rustEqSweep=' + conv.rustEqSweep + ' jsEqSweep=' + conv.jsEqSweep +
    ' sweepLtJs=' + conv.sweepLtJs + ' sweepGtJs=' + conv.sweepGtJs +
    ' sweepMissing=' + conv.sweepMissing + ' sweepNotEqualRust=' + conv.sweepNotEqual);
  console.log('nonLaserDiv=' + nonLaserDiv.length + (nonLaserDiv.length ? ' ' + JSON.stringify(nonLaserDiv.slice(0, 3)) : ''));
  console.log('classification: jsOnly=' + jsOnly + ' rustOnly=' + rustOnly + ' bothAlive=' + bothAlive +
    ' bothDead=' + bothDead + ' same=' + bothDeadSame + ' diffPos=' + posDiff + ' diffNeg=' + negDiff +
    ' geoEventOps=' + geoEventOps + ' jsOnlyGeoAtJdf=' + jsOnlyGeoAtJdf +
    ' rustOnlyWithGeo=' + rustOnlyWithGeo + ' negDiffGeoAtJdf=' + negDiffGeoAtJdf);
  jsOnlyRows.slice(0, 6).forEach((r) => console.log('JS_ONLY sc=' + r.sc + ' op=' + r.op + ' jsDF=' + r.jdf +
    ' geoAtJdf=' + r.geoAtJdf + ' sweepHit=' + r.sweepHit + ' geoEvents=' + JSON.stringify(r.geoEvents) +
    ' bullets=' + JSON.stringify(r.bullets.map((b) => b.w))));
  negRows.slice(0, 6).forEach((r) => console.log('NEG_DIFF sc=' + r.sc + ' op=' + r.op + ' jsDF=' + r.jdf + ' rustDF=' + r.rdf +
    ' diff=' + r.diff + ' geoAtJdf=' + r.geoAtJdf + ' geoEvents=' + JSON.stringify(r.geoEvents)));
  top.forEach((r) => {
    console.log('TOP sc=' + r.sc + ' op=' + r.op + ' jsDF=' + r.jdf + ' rustDF=' + r.rdf + ' diff=' + r.diff +
      ' jsSweepHit=' + r.jsSweep + ' geoFb=' + r.geoFallback + ' sweepFb=' + r.sweepFallback +
      ' bullets=' + JSON.stringify(r.bullets.map((b) => b.w + '/r' + b.r + '/sp' + b.sp.toFixed(1) + '/off' + b.off.toFixed(2))));
  });
  fs.writeFileSync(path.join(__dirname, 'prof', '_lfd_rows_' + sandboxMd5.slice(0, 8) + '.json'),
    JSON.stringify({ sandboxMd5, n: N, seed: SEED, frames: FRAMES, bothDead, diverged,
      diff: { min: diffs.length ? Math.min(...diffs) : null, p50: pct(diffs, 0.5), p90: pct(diffs, 0.9), max: diffs.length ? Math.max(...diffs) : null },
      conv, nonLaserDiv: nonLaserDiv.slice(0, 10), top, rows,
      classification: { jsOnly: jsOnly, rustOnly: rustOnly, bothAlive: bothAlive, bothDead: bothDead,
        bothDeadSame: bothDeadSame, posDiff: posDiff, negDiff: negDiff, geoEventOps: geoEventOps,
        jsOnlyGeoAtJdf: jsOnlyGeoAtJdf, rustOnlyWithGeo: rustOnlyWithGeo, negDiffGeoAtJdf: negDiffGeoAtJdf },
      jsOnlyRows: jsOnlyRows, rustOnlyRows: rustOnlyRows, negRows: negRows }, null, 1));
  console.log('rows written: _tools/headless/prof/_lfd_rows_' + sandboxMd5.slice(0, 8) + '.json');
})().catch((e) => { console.error('FATAL', (e && e.stack) || e); process.exitCode = 1; });
