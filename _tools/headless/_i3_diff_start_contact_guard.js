#!/usr/bin/env node
'use strict';
/* ============================================================================
 * 1-3 起点接触 差分守卫（落盘后不再修改）
 *
 * 修前必 FAIL / 修后必 PASS 的三段证据链：
 *   G1 raw ABI `vt_rollout_batch`：弹摆坦克中心/体内/贴边 → dead=true, df=0
 *      （这一段证明 Rust 物理核心从来没漏判起点重叠）
 *   G2 raw ABI `vt_score_paths`（拦截 bridge 调用，读未被 JS 映射的 deathFrame）
 *   G3 生产消费层 `adapter.simulateTankBatchScored`：dead=true, df=0
 *      ← v172 之前这里是 `dead: r.deathFrame > 0`；若有人改回去，G3/legacy 断言 FAIL
 *   G4 反向验证：把 G3 结果按 v172 前映射 `df > 0` 重放 **必须**得到 -1
 *      （证明本脚本对“fd=0 被消费层吃掉”这一历史 bug 是敏感的）
 *   G5 2×2 输入退化对照（证明 PASS 不是“弹没动”造出来的）：
 *        起点重叠 × {正确速度, 每帧位移} → df=0, df=0
 *        8m 外   × {正确速度, 每帧位移} → 真死, 不死
 *        + no-bullet 对照 → 不死
 *      “8m+正确速度=死 / 8m+每帧位移=不死”⇒ far 的死亡确实要求弹飞完全程。
 *
 * 用法：node _tools/headless/_i3_diff_start_contact_guard.js
 * 退出码：0=PASS，1=FAIL。任何一条断言不满足即 FAIL。
 * ============================================================================ */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const H = require('../../game_core/rust/_diff_proj_semantics_harness.js');

const RESULTS = [];
let FAILS = 0;
function check(name, cond, detail) {
  RESULTS.push({ name, ok: !!cond, detail: detail || '' });
  if (!cond) FAILS++;
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (detail ? '   ' + detail : ''));
}
function md5(p) { try { return crypto.createHash('md5').update(fs.readFileSync(p)).digest('hex'); } catch (e) { return 'n/a'; } }

function staticOps() { const a = []; for (let i = 0; i < 9; i++) a.push(H.staticOp()); return a; }
function rawOps() { return staticOps().map(() => ({ speed: 0, rotationSpeed: 0 })); }
/* 与 sandbox `computeRustOperationSpeeds`（vantage_sandbox.js:1452）同式：
   假坦克 _computeSpeed = fwd?15.95 + back?-12.8；_computeRotationSpeed = left?-5 + right?5。 */
function opsToRaw(operations) {
  return operations.map(o => {
    const i = o.inputs || o;
    return { speed: (i.forward ? 15.95 : 0) + (i.back ? -12.8 : 0),
             rotationSpeed: (i.left ? -5.0 : 0) + (i.right ? 5.0 : 0),
             moving: !!(i.forward || i.back || i.left || i.right) };
  });
}

function bulletAt(y, vyMps, x) {
  return { x: x === undefined ? 15.0 : x, y: y, vx: 0, vy: vyMps, radius: 0.25,
    type: -1, lifetime: 10, lifeLeft: 10, active: true };
}
function rawBatch(S, cacheId, walls, pose, bullet, frames, ops) {
  const input = { cacheId, startPose: { x: pose.x, y: pose.y, rot: pose.rot },
    ops: ops || rawOps(), walls, frames };
  if (bullet) input.bullets = [Object.assign({}, bullet)];
  else input.bullets = [];
  const r = S.VantageRustBridge.rolloutBatch(input);
  if (!r || !r.ok) throw new Error('rolloutBatch failed: ' + (r && r.error));
  return { dead: r.dead.map(Boolean), df: r.deathFrame.map(Number) };
}

/* 每次跑都换新 maze 对象 + 新 aiId + 新 cacheId，避免任何持久世界串味 */
let aiSeq = 0, cacheSeq = 0;
function freshAdapter(S, pose, bullet) {
  const maze = H.makeMaze(4, 3);
  const tank = H.makeFakeTank(S.Box2D, pose.x, pose.y, pose.rot);
  const projs = {};
  if (bullet) projs.b0 = H.makeFakeProjectile(S.Box2D, S.Constants, Object.assign({ id: 'b0' }, bullet));
  const gc = H.makeGameController(maze, tank, projs);
  return { ad: S.VantageSandbox.createAdapter(gc, 'i3g_' + (++aiSeq)), gc, maze };
}
function throughStack(S, pose, bullet, frames, ops, mutate) {
  const { ad } = freshAdapter(S, pose, bullet);
  if (mutate) mutate(ad);
  const opsUse = ops || staticOps();
  const opt = { startPose: pose, threats: [], tGlobal: 0, nowTGlobal: 0,
    auditPurpose: 'jsConfirm', cfg: { deathPenalty: 0, lanePenaltyRatio: 0 } };
  const js = ad.simulateTankBatchJsFused(pose, opsUse, frames, opt);
  if (!js) throw new Error('jsFused returned null');
  let rawScoredDF = null;
  const orig = S.VantageRustBridge.scorePaths;
  S.VantageRustBridge.scorePaths = function (input) {
    const r = orig.call(this, input);
    if (r && r.ok && Array.isArray(r.results)) rawScoredDF = r.results.map(x => Number(x.deathFrame));
    return r;
  };
  let scored;
  try { scored = ad.simulateTankBatchScored(pose, opsUse, frames, opt); }
  finally { S.VantageRustBridge.scorePaths = orig; }
  const jsDF = js.map(r => r.dead ? r.deathFrame : -1);
  if (!scored) return { jsDF, rawScoredDF, curDF: null, legacyDF: null, rustUsed: false };
  return {
    jsDF, rawScoredDF,
    curDF: scored.map(r => r.dead ? r.deathFrame : -1),
    legacyDF: scored.map(r => r.deathFrame > 0 ? r.deathFrame : -1),   // v172 之前的映射
    rustUsed: !!(scored[0] && scored[0].rustPhysics)
  };
}

(async () => {
  const S = H.loadSandbox();
  const VS = S.VantageSandbox;
  await H.initRust(S, 'js/wasm/vantage_core.wasm');
  VS.setRustPhysicsEnabled(true);
  VS.setFrameDtSec(1 / 60);
  const pose = { x: 15, y: 15, rot: 0 };
  const walls = H.extractWallPolygons(S, H.makeMaze(4, 3));
  const F = 75;

  console.log('=== 指纹 ===');
  const f = {
    wasm: md5(H.wasmPath),
    sandbox: md5(path.join(H.root, 'js', 'vantage_sandbox.js')),
    bridge: md5(path.join(H.root, 'js', 'vantage_rust_bridge.js')),
    rollout_rs: md5(path.join(H.root, 'rust', 'vantage_core', 'src', 'rollout.rs')),
    tree_version: (function () {
      try { const m = fs.readFileSync(path.join(H.root, 'js', 'vantage_tree.js'), 'utf8').match(/TREE_VERSION\s*=\s*'([^']+)'/); return m ? m[1] : 'n/a'; } catch (e) { return 'n/a'; }
    })()
  };
  console.log('  ' + JSON.stringify(f));

  const overlap = [
    ['center', bulletAt(15.00, 18)],
    ['inside0.5', bulletAt(15.50, 18)],
    ['edge', bulletAt(17.25, 18)],
  ];
  const far = bulletAt(7.00, 18);
  const farOps = VS.OPERATIONS;   // 9 个标准操作：far 对照要有非平凡轨迹

  console.log('=== G1 raw vt_rollout_batch：起点重叠必须 df=0 ===');
  overlap.forEach(([name, b], i) => {
    const r = rawBatch(S, 41000 + i, walls, pose, b, F);
    check('G1.' + name + ' raw dead=1 & df=0', r.dead.every(Boolean) && r.df.every(d => d === 0),
      'dead=' + JSON.stringify(r.dead) + ' df=' + JSON.stringify(r.df));
  });

  console.log('=== G2+G3 raw vt_score_paths 与生产消费层：起点重叠必须 dead/df=0 ===');
  overlap.forEach(([name, b]) => {
    const t = throughStack(S, pose, b, F);
    check('G2.' + name + ' raw vt_score_paths df=0', t.rawScoredDF && t.rawScoredDF.every(d => d === 0),
      'rawDF=' + JSON.stringify(t.rawScoredDF));
    check('G3.' + name + ' 生产链 dead=1/df=0 (rustUsed)', t.rustUsed && t.curDF && t.curDF.every(d => d === 0),
      'curDF=' + JSON.stringify(t.curDF) + ' rustUsed=' + t.rustUsed + ' jsDF=' + JSON.stringify(t.jsDF));
    check('G4.' + name + ' legacy(>0)重放必为 -1', t.legacyDF && t.legacyDF.every(d => d === -1),
      'legacyDF=' + JSON.stringify(t.legacyDF));
  });

  console.log('=== G5 far-8m 对照 + 2x2 单位退化矩阵 ===');
  const farRaw = rawBatch(S, 41100, walls, pose, far, F, opsToRaw(farOps));
  const farThru = throughStack(S, pose, far, F, farOps);
  // 8m 外静止候选：每 op 走一条 0.3m/帧的弹道，17 帧后命中（golden 见 1-3 实测报告）
  check('G5.far raw 与生产链逐 op 一致', JSON.stringify(farRaw.df) === JSON.stringify(farThru.curDF),
    'rawDF=' + JSON.stringify(farRaw.df) + ' curDF=' + JSON.stringify(farThru.curDF));
  check('G5.far 生产链与 JS 融合逐 op 一致', JSON.stringify(farThru.jsDF) === JSON.stringify(farThru.curDF),
    'jsDF=' + JSON.stringify(farThru.jsDF) + ' curDF=' + JSON.stringify(farThru.curDF));
  check('G5.far 确实发生死亡（弹飞满 8m）', farThru.curDF.some(d => d > 0), 'curDF=' + JSON.stringify(farThru.curDF));

  const wrongUnit = bulletAt(7.00, 18 / 60);          // 把“每帧位移”当速度传：少 50 倍
  const wrongRaw = rawBatch(S, 41120, walls, pose, wrongUnit, F);
  check('G5.2x2 far+每帧位移 必须不死（证明 far 的死要求真飞）', wrongRaw.df.every(d => d === -1),
    'rawDF=' + JSON.stringify(wrongRaw.df));
  const overlapWrong = rawBatch(S, 41121, walls, pose, bulletAt(15.00, 18 / 60), F);
  check('G5.2x2 overlap+每帧位移 仍 df=0（重叠分支与速度单位无关）', overlapWrong.df.every(d => d === 0),
    'rawDF=' + JSON.stringify(overlapWrong.df));
  const noBullet = rawBatch(S, 41122, walls, pose, null, F);
  check('G5.no-bullet 对照 必须全活', noBullet.dead.every(d => d === false),
    'dead=' + JSON.stringify(noBullet.dead));

  console.log('=== G6 反向验证：把消费层改回 v172 前 `dead = df > 0` 的 mutant，本守卫必须报 -1 ===');
  {
    const mutateLegacy = (ad) => {
      const orig = ad.simulateTankBatchScored.bind(ad);
      ad.simulateTankBatchScored = function (state, operations, durationFrames, opt) {
        const r = orig(state, operations, durationFrames, opt);
        if (!r || !r.map) return r;
        return r.map(x => Object.assign({}, x, { dead: x.deathFrame > 0 }));   // v172 前的映射
      };
    };
    const t = throughStack(S, pose, overlap[0][1], F, null, mutateLegacy);
    check('G6 mutant(legacy>0) 必须观测到 df=-1（⇒ 修前守卫必 FAIL）',
      t.rustUsed && t.curDF && t.curDF.every(d => d === -1),
      'mutant curDF=' + JSON.stringify(t.curDF) + ' rawDF=' + JSON.stringify(t.rawScoredDF));
  }

  console.log('\n' + (FAILS ? 'GUARD FAILED (' + FAILS + ')' : 'GUARD PASSED (' + RESULTS.length + '/' + RESULTS.length + ')'));
  process.exitCode = FAILS ? 1 : 0;
})().catch(e => { console.error('FATAL', (e && e.stack) || e); process.exitCode = 1; });
