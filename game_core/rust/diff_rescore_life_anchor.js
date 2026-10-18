#!/usr/bin/env node
// Differential test: real JS `VantageScoring.scorePaths` reference (over a
// real fused batch) vs the in-game Rust/WASM incremental rescore path
// (`adapter.rescoreTankSamples` behind
// VantageSandbox.setRustPhysicsEnabled(true)).
//
// This exercises the exact browser hot-path wiring: stored rolloutSamples are
// rescored by vt_rescore_nodes (ABI v6) through VantageRustBridge, and the
// result is mapped back into the same shape VantageScoring.scorePaths returns.

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { performance } = require('perf_hooks');

const root = path.resolve(__dirname, '..');
const jsBox2D = path.join(root, 'js', 'f1a5ef972c273fb89a098cb50b0f22e7.js');
const jsBundle = path.join(root, 'js', 'b714588dc4621fe104113111ba90b1a7.js');
const jsTactics = path.join(root, 'js', 'ai_tactics.js');
const jsSandbox = path.join(root, 'js', 'vantage_sandbox.js');
const jsScoring = path.join(root, 'js', 'vantage_scoring.js');
const bridgePath = path.join(root, 'js', 'vantage_rust_bridge.js');
const wasmPath = path.join(root, 'js', 'wasm', 'vantage_core.wasm');

const POS_TOL = 1e-9;
const ANG_TOL = 1e-9;

// ---------------------------------------------------------------------------
// VM loading (same recipe as diff_rollout_bridge / diff_rescore)
// ---------------------------------------------------------------------------
function loadSandbox() {
  const sandbox = { console: console };
  sandbox.global = sandbox;
  const ctx = vm.createContext(sandbox);

  // a. Real Box2D source.
  vm.runInContext(fs.readFileSync(jsBox2D, 'utf8'), ctx, { filename: jsBox2D });
  const Box2D = sandbox.Box2D;
  if (!Box2D) throw new Error('Box2D was not defined after loading the JS file');

  // b. Minimal Classy stub (plain object factory).
  function makeClass() {
    const C = {};
    C.classFields = function (o) {
      for (const k in o) if (Object.prototype.hasOwnProperty.call(o, k)) C[k] = o[k];
      return C;
    };
    C.classMethods = function (o) {
      for (const k in o) if (Object.prototype.hasOwnProperty.call(o, k)) C[k] = o[k];
      return C;
    };
    C.methods = function () { return C; };
    C.fields = function () { return C; };
    C.name = function () { return C; };
    return C;
  }
  sandbox.Classy = { newClass: makeClass };

  // c. Load ONLY the Constants and B2DUtils pagespeed lines from the bundle.
  const bundleSrc = fs.readFileSync(jsBundle, 'utf8');
  const bundleLines = bundleSrc.split(/\r?\n/).filter((l) => /^\s*var mod_pagespeed_/.test(l));
  const wanted = ['mod_pagespeed_QSIkKJ9Ibg', 'mod_pagespeed__SHLt6ORr2'];
  for (const name of wanted) {
    const line = bundleLines.find((l) => l.indexOf('var ' + name) >= 0);
    if (!line) throw new Error('bundle line not found: ' + name);
    vm.runInContext(line, ctx, { filename: 'bundle-' + name + '.js' });
    vm.runInContext(sandbox[name], ctx, { filename: 'bundle-' + name + '-eval.js' });
  }

  // d/e/f. Real AI tactics, VantageSandbox and VantageScoring modules.
  vm.runInContext(fs.readFileSync(jsTactics, 'utf8'), ctx, { filename: jsTactics });
  vm.runInContext(fs.readFileSync(jsSandbox, 'utf8'), ctx, { filename: jsSandbox });
  vm.runInContext(fs.readFileSync(jsScoring, 'utf8'), ctx, { filename: jsScoring });
  sandbox._ctx = ctx;

  return sandbox;
}

// ---------------------------------------------------------------------------
// Fakes (minimal but complete for B2DUtils + simulateFusedBatch)
// ---------------------------------------------------------------------------
function makeFakeTankBody(Box2D, x, y, rot) {
  const b2Vec2 = Box2D.Common.Math.b2Vec2;
  return {
    _pos: new b2Vec2(x, y),
    _vel: new b2Vec2(0, 0),
    _angle: rot,
    _angVel: 0,
    _active: true,
    GetPosition: function () { return new b2Vec2(this._pos.x, this._pos.y); },
    GetAngle: function () { return this._angle; },
    GetLinearVelocity: function () { return new b2Vec2(this._vel.x, this._vel.y); },
    GetAngularVelocity: function () { return this._angVel; },
    SetPositionAndAngle: function (p, a) { this._pos.x = p.x; this._pos.y = p.y; this._angle = a; },
    SetLinearVelocity: function (v) { this._vel.x = v.x; this._vel.y = v.y; },
    SetAngularVelocity: function (w) { this._angVel = w; },
    SetAwake: function () {},
    SetActive: function (a) { this._active = a; },
    IsActive: function () { return this._active; },
  };
}

function makeFakeProjectileBody(Box2D, x, y, vx, vy, radius) {
  const b2Vec2 = Box2D.Common.Math.b2Vec2;
  return {
    _pos: new b2Vec2(x, y),
    _vel: new b2Vec2(vx, vy),
    _angle: 0,
    _angVel: 0,
    _active: true,
    _fixture: { GetShape: function () { return { m_radius: radius }; } },
    GetPosition: function () { return new b2Vec2(this._pos.x, this._pos.y); },
    GetAngle: function () { return this._angle; },
    GetLinearVelocity: function () { return new b2Vec2(this._vel.x, this._vel.y); },
    GetAngularVelocity: function () { return this._angVel; },
    GetFixtureList: function () { return this._fixture; },
    SetPositionAndAngle: function (p, a) { this._pos.x = p.x; this._pos.y = p.y; this._angle = a; },
    SetLinearVelocity: function (v) { this._vel.x = v.x; this._vel.y = v.y; },
    SetAngularVelocity: function (w) { this._angVel = w; },
    SetAwake: function () {},
    SetActive: function (a) { this._active = a; },
    IsActive: function () { return this._active; },
  };
}

function makeFakeTank(Box2D, x, y, rot) {
  const body = makeFakeTankBody(Box2D, x, y, rot);
  const tank = {
    x: x,
    y: y,
    rotation: rot,
    forward: false,
    back: false,
    left: false,
    right: false,
    locked: false,
    speed: 0,
    rotationSpeed: 0,
    getX: function () { return this.x; },
    getY: function () { return this.y; },
    getRotation: function () { return this.rotation; },
    getB2DBody: function () { return body; },
    _computeSpeed: function () {
      this.speed = (this.forward ? 15.95 : 0) + (this.back ? -12.8 : 0);
    },
    _computeRotationSpeed: function () {
      this.rotationSpeed = (this.left ? -5.0 : 0) + (this.right ? 5.0 : 0);
    },
  };
  return tank;
}

function makeFakeProjectile(Box2D, Constants, x, y, vx, vy, radius) {
  const body = makeFakeProjectileBody(Box2D, x, y, vx, vy, radius);
  return {
    _x: x,
    _y: y,
    _vx: vx,
    _vy: vy,
    lifetime: 10,
    age: 0,
    done: function () { return false; },
    getTimeAlive: function () { return this.age; },
    getType: function () { return Constants.WEAPON_TYPES.BULLET; },
    getB2DBody: function () { return body; },
    getX: function () { return this._x; },
    getY: function () { return this._y; },
    getSpeedX: function () { return this._vx; },
    getSpeedY: function () { return this._vy; },
  };
}

function makeMaze(W, H) {
  const tiles = [];
  for (let i = 0; i < W; i++) {
    tiles[i] = [];
    for (let j = 0; j < H; j++) {
      tiles[i][j] = [1, j === 0 ? 1 : 0, i === 0 ? 1 : 0];
    }
  }
  return {
    getTiles: function () { return tiles; },
  };
}

function makeGameController(maze, tank, projectiles) {
  return {
    getMaze: function () { return maze; },
    getTank: function (id) { return tank; },
    getTanks: function () { return { p0: tank }; },
    getProjectiles: function () { return projectiles; },
    getB2DWorld: function () { return null; },
  };
}

function isMovingInputs(inputs) {
  return !!(inputs && (inputs.forward || inputs.back || inputs.left || inputs.right));
}


// ===========================================================================
// E1（S3）：`lifeLeftSeconds` 到底该传「现在剩余寿命」还是「轨迹锚点处剩余寿命」。
//
// 场景：一颗**已经飞了 N_OFF 帧**的弹（轨迹锚点 A = -N_OFF*FRAME，即树在
// 上一个段末锚定它、之后根前进到现在，属于「复用轨迹」的正常形态）。
// 树的 rescore 把节点样本交给 Rust；Rust 认为「锚点处剩余寿命 = L」，
// 逐帧 life_left = L - (t_k - A)。
//
//   现在 JS 传 L_now（= lifetime - getTimeAlive()，"现在"口径）
//     → Rust 少给 Δ = now_rel - A 秒 ⇒ 弹提前退场 ⇒ 最后 Δ 秒里的致命帧丢失。
//   正确值 L* = L_now + (now_rel - A)（锚点处剩余寿命，per-threat，与 start_t 无关）
//     → 与 JS 融合世界（死亡权威）逐帧口径一致。
//
// 本脚本对同一批节点、同一条 track 扫 lifetime，打印三列死亡帧：
//   fd_js    = JS 融合世界（权威，scorePaths/fused）
//   fd_now   = Rust rescore + 现状口径（L_now）
//   fd_star  = Rust rescore + 正确口径（L*；修好后由第 5 个参数 nowTGlobal 驱动）
// 判据（修好后必须成立）：fd_star === fd_js 恒成立；fd_now 在弹寿命尾部会漏死。
// ===========================================================================
'use strict';

const FRAME = 0.02;
const N_OFF = 5;                     // 轨迹锚点比"现在"早 5 帧 ⇒ Δ = 0.1s
const DELTA = N_OFF * FRAME;

let globalSandbox = null;
let globalBridge = null;

async function main() {
  globalSandbox = loadSandbox();
  const sandbox = globalSandbox;
  sandbox.WebAssembly = WebAssembly;
  sandbox.fetch = async function () {
    const bytes = fs.readFileSync(wasmPath);
    return {
      ok: true,
      arrayBuffer: async function () {
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      },
    };
  };
  vm.runInContext(fs.readFileSync(bridgePath, 'utf8'), sandbox._ctx, { filename: bridgePath });
  globalBridge = sandbox.VantageRustBridge;

  const Box2D = sandbox.Box2D;
  const Constants = sandbox.Constants;
  const VantageSandbox = sandbox.VantageSandbox;
  const VantageScoring = sandbox.VantageScoring;
  if (!VantageSandbox) throw new Error('VantageSandbox was not defined');
  if (!VantageScoring) throw new Error('VantageScoring was not defined');

  const ops = VantageSandbox.OPERATIONS;
  const frames = 75;
  const cfg = {
    deathPenalty: 0,
    stuckPenalty: 4.0,
    stuckDistEps: 0.05,
    stuckRotEps: 0.05,
    lanePenaltyRatio: 0,
    springRopeEnabled: false,
  };

  const maze = makeMaze(4, 3);
  const startPose = { x: 5.0, y: 8.0, rot: 0.0 };
  const tank = makeFakeTank(Box2D, startPose.x, startPose.y, startPose.rot);
  const bullet = makeFakeProjectile(Box2D, Constants, 5.0, 12.0, 0.0, -18.0, 0.25);
  const projectiles = { b1: bullet };
  const adapter = VantageSandbox.createAdapter(
    makeGameController(maze, tank, projectiles), 'p0'
  );

  const init = await globalBridge.init('js/wasm/vantage_core.wasm');
  if (!init.ok) throw new Error('bridge init failed: ' + init.error);
  if (globalBridge.version() !== 12) {
    throw new Error('expected wasm ABI v12, got ' + globalBridge.version());
  }

  let rustWarnCount = 0;
  const rustNativeWarn = sandbox.console.warn.bind(sandbox.console);
  sandbox.console.warn = function () {
    rustWarnCount++;
    rustNativeWarn.apply(null, arguments);
  };

  const originPos = { x: 5.0, y: 14.0 };   // 远离候选传感器的出生点（传感器盒 ~3x4）
  const VY = -18.0;

  function placeBullet(x, y, age) {
    bullet._x = x; bullet._y = y;
    bullet.getB2DBody().SetPositionAndAngle(Box2D.Common.Math.b2Vec2.Make(x, y), 0);
    bullet.getB2DBody().SetLinearVelocity(Box2D.Common.Math.b2Vec2.Make(0, VY));
    bullet.age = age;
  }

  function buildTrack(lifetimeSec) {
    bullet.lifetime = lifetimeSec;
    placeBullet(originPos.x, originPos.y, 0);
    const tracks = adapter.simulateBulletTracks(frames);
    if (!tracks || !tracks.length || !tracks[0].frames.length) return null;
    return tracks[0].frames;
  }

  console.log('scene            : lifeLeftSeconds 语义（锚点复用轨迹 + 弹在节点尾部到期）');
  console.log('  FRAME=' + FRAME + 's  锚点偏移 A = -' + N_OFF + ' 帧 = -' + DELTA.toFixed(3) +
    's  ⇒ Δ = now_rel - A = ' + DELTA.toFixed(3) + 's（' + N_OFF + ' 帧）');
  console.log('  锚点起寿命 | L_now   L*      | fd_js  fd_now  fd_star  fd_param | 结论');

  let diffs = 0, checked = 0, firstDiff = null;
  const rows = [];
  for (let k = 0; k <= 26; k++) {
    const ltFrames = N_OFF + 4 + k;         // 锚点起的寿命帧数
    const lifetimeSec = ltFrames * FRAME;
    const track = buildTrack(lifetimeSec);
    if (!track) { console.log('  track 生成失败 ltFrames=' + ltFrames); continue; }
    if (track.length < N_OFF + 2) { continue; }

    // 把真实弹体挪到「现在」= track[N_OFF]，年龄 = Δ
    const nowFrame = track[N_OFF];
    placeBullet(nowFrame.x, nowFrame.y, N_OFF * FRAME);

    const L_now = Math.max(0, lifetimeSec - bullet.getTimeAlive());
    const L_star = L_now + DELTA;

    const threats = [{
      id: 'b1',
      track: track,
      trackFrameDt: FRAME,
      anchorOffset: -DELTA,      // 轨迹第 0 帧在根之前 Δ 秒
      speed: 18.0,
      bulletRadius: 0.25,
      lifeLeftSeconds: L_now,
    }];

    // ---- JS 融合权威（root = now，tGlobal=0，nowTGlobal=0）----
    const fusedBatch = adapter.simulateTankBatch(startPose, ops, frames, {
      startPose: startPose, threats: threats, tGlobal: 0, nowTGlobal: 0,
    });
    if (!fusedBatch) throw new Error('fused batch null');
    if (process.env.DBG) {
      const sum = adapter.getLastFusedBatchSummary ? adapter.getLastFusedBatchSummary() : null;
      console.log('    [dbg] lt=' + ltFrames + ' trackLen=' + track.length +
        ' t0=' + JSON.stringify(track[0]) + ' t5=' + JSON.stringify(track[5]) +
        ' now=(' + nowFrame.x.toFixed(2) + ',' + nowFrame.y.toFixed(2) + ') age=' + bullet.getTimeAlive());
      console.log('    [dbg] batch=' + JSON.stringify(fusedBatch.map((r) => [r.dead, r.deathFrame])));
      console.log('    [dbg] audit=' + JSON.stringify(sum && {
        tGlobal: sum.tGlobal, nowTGlobal: sum.nowTGlobal,
        placements: (sum.placements || []),
        contacts: (sum.contacts || []).slice(0, 2),
      }));
    }
    const fakeAdapter = {
      constants: adapter.constants,
      bulletPosAt: function (path, speed, timeSec) { return adapter.bulletPosAt(path, speed, timeSec); },
      simulateTankBatch: function () { return fusedBatch; },
    };
    const jsResults = VantageScoring.scorePaths(
      fakeAdapter, { tank: startPose, tGlobal: 0, nowTGlobal: 0 }, ops, frames, threats, cfg
    );

    const nodes = fusedBatch.map((r, j) => ({
      samples: r.samples,
      moving: isMovingInputs(ops[j].inputs),
      startT: 0,
      frames: frames,
    }));

    VantageSandbox.setRustPhysicsEnabled(true);
    // 本场景 root = now ⟹ nowRel = 0；Δ = nowRel - A = -A = DELTA。
    // ① 旧口径：把第 5 个参数传成 A ⇒ 修正量 = A - A = 0（= 修改前"根本不换算"的行为）。
    //    这样 before/after 两个阶段都能复现旧口径。
    const rustNow = adapter.rescoreTankSamples(nodes, threats, cfg, null, -DELTA);
    // ② L* 口径（实现无关的构造法）：仍把第 5 个参数传 A（修正量 0，去掉代码自带换算），
    //    只把真实弹的年龄减 Δ ⇒ JS 算出的 L_now' = LT-(age-Δ) = L*。
    placeBullet(nowFrame.x, nowFrame.y, N_OFF * FRAME - DELTA);
    const rustStar = adapter.rescoreTankSamples(nodes, threats, cfg, null, -DELTA);
    // ③ 生产口径：沙箱按第 5 个参数 nowTGlobal 自己换算（修好后 ②≡③）。
    placeBullet(nowFrame.x, nowFrame.y, N_OFF * FRAME);
    const rustParam = adapter.rescoreTankSamples(nodes, threats, cfg, null, 0);
    VantageSandbox.setRustPhysicsEnabled(false);
    if (!rustNow || !rustStar || !rustParam) throw new Error('rescore returned null');

    const i0 = 0;   // op0 = 静止：弹正面飞来
    const fdJs = jsResults[i0].deathFrame;
    const fdNow = rustNow[i0].deathFrame;
    const fdStar = rustStar[i0].deathFrame;
    const fdParam = rustParam[i0].deathFrame;

    checked++;
    const badNow = fdNow !== fdJs;
    const badStar = fdStar !== fdJs;
    if (badNow) diffs++;
    if ((badNow || badStar) && !firstDiff) {
      firstDiff = { ltFrames, L_now, L_star, fdJs, fdNow, fdStar };
    }
    // Rust 侧寿命退场口径（rollout.rs / rescore.rs 的 `life_left -= frame_dt; if <=0 停用`）：
    // 帧 k 能判死 ⟺ k*FRAME < L* + A - FRAME
    const kmax = Math.ceil((L_star + (-DELTA)) / FRAME) - 2;
    rows.push({ ltFrames, L_now, L_star, fdJs, fdNow, fdStar, fdParam, kmax });
    console.log('  ' + String(ltFrames).padStart(3) + ' 帧     | ' +
      L_now.toFixed(3) + '  ' + L_star.toFixed(3) + '  |  ' +
      String(fdJs).padStart(3) + '       ' + String(fdNow).padStart(3) + (badNow ? '*' : ' ') +
      '           ' + String(fdStar).padStart(3) + (badStar ? '*' : ' ') +
      '          ' + String(fdParam).padStart(3) + (fdParam === fdStar ? ' ' : '?') + '     | ' +
      (badNow ? 'L_now 漏死' : '') + (badStar ? ' L* 不符' : (fdJs > kmax ? '(到期边界)' : '')));
  }

  console.log('  合计：' + diffs + '/' + checked + ' 个寿命取值上「L_now 口径」与 JS 权威死亡帧不一致');
  if (firstDiff) {
    console.log('  首个不一致：锚点起寿命 ' + firstDiff.ltFrames + ' 帧（L_now=' + firstDiff.L_now.toFixed(3) +
      's, L*=' + firstDiff.L_star.toFixed(3) + 's） fd_js=' + firstDiff.fdJs +
      ' fd_now=' + firstDiff.fdNow + ' fd_star=' + firstDiff.fdStar);
  }
  if (rustWarnCount !== 0) throw new Error('Rust rescore path emitted ' + rustWarnCount + ' warning(s)');

  // ------------------------------------------------------------------
  // 判据（随施工阶段切换）：
  //   PHASE=before（默认）: 必须复现「L_now 漏死」，且 L* 口径必须与 JS 权威一致
  //   PHASE=after         : fd_star（= 生产代码现在的口径）必须逐行等于 JS 权威
  // ------------------------------------------------------------------
  const phase = process.env.PHASE || 'before';
  // 期望值：JS 权威死帧落在 Rust 寿命窗口内 ⇒ 必须逐位一致；落在窗口外 ⇒ 只能是 -1（保守漏，
  // 绝不允许凭空多出一个 JS 权威没看见的死）。
  const expectStar = rows.map((r) => (r.fdJs <= r.kmax ? r.fdJs : -1));
  const badStar = rows.filter((r, i) => r.fdStar !== expectStar[i]);
  const badParam = rows.filter((r) => r.fdParam !== r.fdStar);
  const badNow = rows.filter((r, i) => r.fdNow !== expectStar[i]);
  const fixed = rows.filter((r) => r.fdNow !== r.fdJs && r.fdStar === r.fdJs);
  const knife = rows.filter((r) => r.fdJs > r.kmax);
  console.log('  [info] 行数=' + rows.length + '  其中"JS 死帧落在 Rust 寿命窗口外"的到期边界行=' + knife.length +
    '（窗口 kmax=' + rows.map((r) => r.kmax).join('/') + '）');
  console.log('  [info] fd_now  偏离期望的行数 : ' + badNow.length + ' / ' + rows.length);
  console.log('  [info] fd_star 偏离期望的行数 : ' + badStar.length + ' / ' + rows.length);
  console.log('  [info] L_now 漏死、L* 修回的行数 : ' + fixed.length + ' / ' + rows.length +
    (fixed.length ? '（' + fixed.map((r) => 'L_now=' + r.L_now.toFixed(2) + '→' + r.fdNow + ' L*→' + r.fdStar).join('; ') + '）' : ''));
  console.log('  [info] fd_param 偏离 fd_star 的行数 : ' + badParam.length + ' / ' + rows.length);
  if (badStar.length) throw new Error('E1 FAIL：L* 口径与 JS 权威不一致（' + badStar.length + ' 行）→ 场景或语义有问题');
  if (phase === 'after') {
    if (badParam.length) throw new Error('E1 FAIL：第 5 个参数 nowTGlobal 没有复现 L* 口径');
    if (!badNow.length) throw new Error('E1 FAIL：fd_now 竟然全对 —— 缺陷没复现，场景需重设');
    console.log('DIFF RESCORE LIFE ANCHOR PASSED (after) 固定修复行数=' + fixed.length);
  } else {
    if (!diffs) throw new Error('E1 FAIL：L_now 口径没有产生任何死亡帧差异（则该条不必修）');
    if (!badNow.length) throw new Error('E1 FAIL：fd_now 竟然全对 —— 缺陷没复现');
    console.log('DIFF RESCORE LIFE ANCHOR: 缺陷已复现（before）fd_now 漏死行数=' + badNow.length);
  }
}

main().catch((e) => {
  console.error('diff_rescore_life_anchor.js error:', (e && e.stack) || e);
  process.exitCode = 2;
});
