'use strict';
/**
 * 树修「B 决策被拒 ⟹ 坦克退化成静止」—— 只读探针
 * ==========================================================================
 * 用途：跑 1v1 ≥150 帧，逐帧记录【树到底想执行什么】+【输入有没有方向】+【真的动没动】，
 *       并在末尾汇总：按 (决策 | 输入有方向?) 分组 → 帧数 / 移动帧数；giveUpA/B；拒绝理由分布。
 *
 * 判据（主人 2026-10-19）：
 *   · `树:静止` 占比 < 5%（修前 43%）
 *   · 实际移动帧数【显著上升】（修前 23/150）
 *   · giveUpB 接近 0（修前 145~225）
 *
 * 用法：
 *   PYTHONIOENCODING=utf-8 node _tools/perf/treefix_probe.js [--frames=150] [--ckpt=...] [--tag=xxx]
 * 环境变量：VT_CKPT（默认 D:/vt_run/t12/ckpt/last.pt）
 *
 * ⛔ 只读：不写任何训练数据、不改权重、不改游戏逻辑。
 *   唯一的"写入"是喂 `window.__g1.step(row)` / `setFire()`，与既有采集探针同口径。
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '../..');
process.chdir(ROOT);
const { spawn } = require('child_process');
const { Match } = require(ROOT + '/_tools/headless/match.js');
const { makeAsk } = require(ROOT + '/_tools/headless/_policy_client.js');

const argv = {};
for (const a of process.argv.slice(2)) {
  const m = /^--([^=]+)=(.*)$/.exec(a);
  if (m) argv[m[1]] = m[2];
}
const FRAMES = Number(argv.frames || 150);
const CKPT = argv.ckpt || process.env.VT_CKPT || 'D:/vt_run/t12/ckpt/last.pt';
const TAG = argv.tag || 'run';
const DIAG = argv.diag !== '0';
const MUTE_OPP = argv.muteOpp === '1';
const NO_FIRE = argv.noFire === '1';

const INJECT = argv.inject ? path.resolve(ROOT, argv.inject) : (ROOT + '/_tools/headless/_g1_inject.js');
const SRC = fs.readFileSync(INJECT, 'utf8');
const SEED_BASE = Number(argv.seedBase || 1);
const WARM = Number(argv.warmup || 30);

// 页面侧：一次 eval 取回全部只读证据（树意图 + 输入 + 接口计数 + 行号→uid 诊断 + 树 stats）
const PAGE_STATE = `(() => {
  var out = { op: null, any: 0, fire: 0, iface: null, tv: null, diag: null, stats: null };
  // ⭐⭐ 不能调 getDesiredOperation()：它每调一次就把 B 路线游标 +1（agentExecEnsure）⇒ 探针会把轨迹推快一倍。
  //   改读 **树自己回显的「最后一次交给 AI 的操作」**（stats.lastDesiredOp，只读）+ AI 实际存下的 vantageControlOpName。
  try {
    var t0 = VantageTree.getTree();
    out.op = (t0 && t0.stats && t0.stats.lastDesiredOp) ? t0.stats.lastDesiredOp : 'none';
    out.opFrame = (t0 && t0.stats) ? t0.stats.lastDesiredFrame : null;
  } catch (e) { out.opErr = String(e && e.message || e); }
  try {
    var ms0 = AIs.aiManagers || [], g0 = null;
    for (var i0 = 0; i0 < ms0.length; i0++) { if (ms0[i0] && ms0[i0].isVantage) { g0 = ms0[i0]; break; } }
    out.applied = g0 && g0.ai ? (g0.ai.vantageControlOpName || '(never)') : null;
  } catch (e0) { out.appliedErr = String(e0 && e0.message || e0); }
  try {
    var ms = AIs.aiManagers || [], g = null;
    for (var i = 0; i < ms.length; i++) { if (ms[i] && ms[i].isVantage) { g = ms[i]; break; } }
    if (g) { var s = g.ai.getInputState();
      out.inF = !!s.getForward(); out.inB = !!s.getBack(); out.inL = !!s.getLeft(); out.inR = !!s.getRight();
      out.any = (out.inF || out.inB || out.inL || out.inR) ? 1 : 0;
      out.fire = s.getFire() ? 1 : 0;
      out.sub = g.storedStates ? { f: !!g.storedStates.forward, b: !!g.storedStates.back,
        l: !!g.storedStates.left, r: !!g.storedStates.right, fire: !!g.storedStates.fire } : null; }
  } catch (e2) { out.inErr = String(e2 && e2.message || e2); }
  try {
    var IS = window.__vantageIface;
    if (IS) out.iface = { calls: IS.calls, callsA: IS.callsA, callsB: IS.callsB, rejected: IS.rejected,
      giveUp: IS.giveUp, giveUpA: IS.giveUpA, giveUpB: IS.giveUpB, retries: IS.retries,
      tickCalls: IS.tickCalls, tickEnter: IS.tickEnter, tickBail: IS.tickBail,
      skipped: IS.skipped, selectViolationRejected: IS.selectViolationRejected,
      selectAllTrueDeadPass: IS.selectAllTrueDeadPass, fireSelfHit: IS.fireSelfHit,
      notFound: IS.notFound, notFoundA: IS.notFoundA, notFoundB: IS.notFoundB,
      notFoundInReserve: IS.notFoundInReserve, notFoundEverSeen: IS.notFoundEverSeen,
      notFoundSample: IS.notFoundSample };
  } catch (e3) { out.ifErr = String(e3 && e3.message || e3); }
  // 「到底谁在开车」的证据：控制操作是否还在 tree 模式 / 树这一帧有没有 tick / 游戏是否暂停
  try {
    var ctrl = VantageTestbench.getControlOperation();
    out.ctrl = ctrl ? (ctrl.mode + '|' + ctrl.opName) : null;
  } catch (eC) { out.ctrlErr = String(eC && eC.message || eC); }
  try { out.frozen = VantageTree.isFrozen() ? 1 : 0; } catch (eF) { out.frozen = -1; }
  try { var gm = GameManager.getGame(); out.paused = gm && gm.paused ? 1 : 0; } catch (eP) { out.paused = -1; }
  try { out.gstate = GameManager.getGameController().getState(); } catch (eG) { out.gstate = null; }
  try {
    var t = VantageTree.getTree();
    if (t && t.stats) out.stats = { agentRouteId: t.stats.agentRouteId, agentFireFrames: t.stats.agentFireFrames,
      agentACalls: t.stats.agentACalls, agentBCalls: t.stats.agentBCalls, agentRouteUsed: t.stats.agentRouteUsed,
      agentFireSelfHitDetected: t.stats.agentFireSelfHitDetected, agentSkippedFull: t.stats.agentSkippedFull };
    if (t) out.tv = { nodeCount: t.nodeCount, commitId: t.commitNode ? t.commitNode.id : null,
      rootId: t.root ? t.root.id : null, depth: t.commitPath ? t.commitPath.length : null,
      reserveCount: t.reserveCount || 0 };
  } catch (e4) { out.tvErr = String(e4 && e4.message || e4); }
  try {
    var G = window.__g1;
    out.diag = { lastRowToUid: G.lastRowToUid || null, mapApplied: G.mapApplied || 0,
      mapNoTokN: G.mapNoTokN || 0, rowOutOfRange: G.rowOutOfRange || 0,
      pickFound: G.pickFound || 0, pickNotFound: G.pickNotFound || 0,
      mapFallback: G.mapFallback || 0, mapFallbackTo: G.mapFallbackTo || null,
      routeUnreachable: G.routeUnreachable || 0, fireDropN: G.fireDropN || 0,
      firePicksEmpty: G.firePicksEmpty || 0, fireFrame: G.fireFrame, lastChainLen: G.lastChainLen || 0,
      dbgTargetOp: G.dbgTargetOp || null, dbgTargetId: G.dbgTargetId || null, dbgBack: G.dbgBack,
      dbgHopOp: G.dbgHopOp || null, dbgHopId: G.dbgHopId || null, dbgHopL: G.dbgHopL || null,
      dbgHopStart: G.dbgHopStart, dbgHopsN: G.dbgHopsN, dbgTotalF: G.dbgTotalF, dbgStartFrame: G.dbgStartFrame,
      firePicksN: G.firePicksN || 0, fireCommitId: G.fireCommitId || null, fireCommitL: G.fireCommitL || null };
  } catch (e5) { out.diagErr = String(e5 && e5.message || e5); }
  return JSON.stringify(out);
})()`;

(async () => {
  const srv = spawn('py', ['-3.13', '_tools/training/policy_server_graph.py'],
    { env: Object.assign({}, process.env, { PYTHONIOENCODING: 'utf-8', VT_CKPT: CKPT }) });
  await new Promise((r) => {
    const h = (d) => { if (String(d).indexOf('WARMUP_SAMPLE') < 0) return; srv.stdout.off('data', h); r(); };
    srv.stdout.on('data', h);
  });
  const ask = makeAsk(srv);
  const m = new Match();
  await m.open({ humanIds: [], aiCount: 1, vantCount: 1, control: false });
  await m.eval(SRC);
  await m.eval('window.__g1.subscribe()');
  await m.eval('window.__g1.setup()');
  if (DIAG) await m.eval('window.__vtDiag = 1');       // 树侧明细诊断（只读）
  if (argv.treeRootLayer === '0') await m.eval('window.__vtAllowRootLayer = 0');   // A/B：关掉"无弹建根层"
  if (MUTE_OPP) {
    // ★ 主人补丁：把非 vantage 的 AI 打成哑巴 ⟹ 场上可以【始终没有子弹】
    const muted = await m.eval(`(function(){var ms=AIs.aiManagers||[];var n=0;
      for(var i=0;i<ms.length;i++){var g=ms[i]; if(!g||g.isVantage)continue; var ai=g.ai; if(!ai)continue;
        ai.update=function(){try{this.inputState=InputState.withState(this.aiId,false,false,false,false,false);}catch(e){}};
        ai._makeDecisionsExceptGoal=undefined;
        ai._makeDecisionsAndUpdateGoal=function(){return false;}; ai.actions=[]; n++;}
      return n;})()`);
    console.log('[probe] muteOpp 打哑的 AI 数 = ' + muted);
  }
  await m.pump(WARM, { yieldMs: 0 });
  await m.eval('window.__g1.setFire(' + (NO_FIRE ? 0 : 1) + ')');
  // ⭐ 预热期间的计数器快照（预热期还没有 bundle ⟹ 会有 30 次 no-output 放弃，不能算到后面头上）
  const baseSnap = JSON.parse(await m.eval('JSON.stringify({ is: (function(){var I=window.__vantageIface||{};return {giveUpA:I.giveUpA||0,giveUpB:I.giveUpB||0,callsA:I.callsA||0,callsB:I.callsB||0,rejected:I.rejected||0,retries:I.retries||0,notFound:I.notFound||0};})(), g1: (function(){var G=window.__g1||{};return {mapApplied:G.mapApplied||0,mapNoTokN:G.mapNoTokN||0,rowOutOfRange:G.rowOutOfRange||0,pickFound:G.pickFound||0,pickNotFound:G.pickNotFound||0,mapFallback:G.mapFallback||0,routeUnreachable:G.routeUnreachable||0,fireDropN:G.fireDropN||0,firePicksEmpty:G.firePicksEmpty||0,firePicksN:G.firePicksN||0};})() })'));

  let nodeId = 0;
  const byOp = {};
  const EXPECT = { '静止': [0,0,0,0], '前': [1,0,0,0], '后': [0,1,0,0], '左': [0,0,1,0], '右': [0,0,0,1],
                   '前左': [1,0,1,0], '前右': [1,0,0,1], '后左': [0,1,1,0], '后右': [0,1,0,1] };
  const opBase = (op) => String(op || '').replace(/^B:|^树:/, '').replace(/\+fire$/, '');
  let inputMismatch = 0, inputMismatchByOp = {};
  const rows = [];
  let moved = 0, prevPos = null, opMissing = 0, opAppliedMismatch = 0;
  let fireInputFrames = 0, shots = 0, prevFired = null, projFrames = 0;
  let dirB = 0, dirBMoved = 0, dirT = 0, dirTMoved = 0, bulletFrames = 0;
  let ctrlNotTree = 0, deadTickFrames = 0, lastTickCalls = null;
  let lastIface = null, lastDiag = null, lastTv = null, lastStats = null;

  for (let f = 0; f < FRAMES; f++) {
    const o = JSON.parse(await m.eval('window.__g1.step(' + nodeId + ')'));
    await m.pump(1, { yieldMs: 0 });

    // 真实位移：用 step 开头抓的双方位姿（pl[vid]），两帧相比 = 1 帧内是否真的动了
    let pos = null;
    try {
      const vid = o.vid || null;
      if (vid && o.pl && o.pl[vid]) pos = [o.pl[vid].x, o.pl[vid].y, o.pl[vid].rot];
    } catch (e) { }
    const didMove = !!(pos && prevPos && (pos[0] !== prevPos[0] || pos[1] !== prevPos[1]));
    if (pos) prevPos = pos;
    if (didMove) moved++;

    // 开火证据：武器 fired 计数增量 + 场上有我方子弹的帧
    try {
      const vid = o.vid; const w = vid && o.wep && o.wep[vid];
      if (w && typeof w.fired === 'number') {
        if (prevFired !== null && w.fired > prevFired) shots += (w.fired - prevFired);
        prevFired = w.fired;
      }
      if (o.projBy && vid && o.projBy[vid] > 0) projFrames++;
    } catch (eF) { }
    const st = JSON.parse(await m.eval(PAGE_STATE));
    if (st.fire) fireInputFrames++;
    if (st.op === 'none' || st.op === null) opMissing++;
    lastIface = st.iface; lastDiag = st.diag; lastTv = st.tv; lastStats = st.stats;

    if (st.applied && st.applied !== st.op) opAppliedMismatch++;
    const exp = EXPECT[opBase(st.op)];
    if (exp && st.any !== undefined) {
      const got = [st.inF ? 1 : 0, st.inB ? 1 : 0, st.inL ? 1 : 0, st.inR ? 1 : 0];
      if (got.join('') !== exp.join('')) {
        inputMismatch++;
        inputMismatchByOp[st.op] = (inputMismatchByOp[st.op] || 0) + 1;
      }
    }
    // 「树意图有方向 ⟹ 真的动了」的保真度（B:* / 树:* 分开统计）
    if (exp && exp.some((x) => x === 1)) {
      if (/^B:/.test(st.op)) { dirB++; if (didMove) dirBMoved++; }
      else { dirT++; if (didMove) dirTMoved++; }
    }
    const key = st.op + ' | 输入有方向=' + (st.any ? 'true' : 'false');
    byOp[key] = byOp[key] || { n: 0, moved: 0 };
    byOp[key].n++; if (didMove) byOp[key].moved++;
    const projN = (o.projN || 0) | 0;
    if (projN > 0) bulletFrames++;
    if (st.ctrl && !/^tree/.test(String(st.ctrl))) ctrlNotTree++;
    if (!st.tickCalls || st.tickCalls === lastTickCalls) deadTickFrames++;
    lastTickCalls = st.tickCalls;
    rows.push({ f, projN, op: st.op, applied: st.applied, opFrame: st.opFrame, any: st.any,
      ctrl: st.ctrl, frozen: st.frozen, paused: st.paused, gstate: st.gstate, tickCalls: st.tickCalls,
      dbg: st.diag ? { tOp: st.diag.dbgTargetOp, tId: st.diag.dbgTargetId, hOp: st.diag.dbgHopOp,
        hId: st.diag.dbgHopId, hL: st.diag.dbgHopL, hStart: st.diag.dbgHopStart,
        hopsN: st.diag.dbgHopsN, totalF: st.diag.dbgTotalF, startFrame: st.diag.dbgStartFrame } : null,
      inp: [st.inF ? 1 : 0, st.inB ? 1 : 0, st.inL ? 1 : 0, st.inR ? 1 : 0], sub: st.sub, fire: st.fire, moved: didMove,
      rowToUid: st.diag && st.diag.lastRowToUid, route: st.stats ? st.stats.agentRouteId : null,
      fireFrames: st.stats ? st.stats.agentFireFrames : null, nodeCount: st.tv ? st.tv.nodeCount : null,
      commitId: st.tv ? st.tv.commitId : null, giveUpB: st.iface ? st.iface.giveUpB : null,
      skipped: st.iface ? st.iface.skipped : null });

    const N = (o.N || 0) | 0;
    if (N > 0 && o.segs) {
      const segs = { node: o.segs.node, opp: o.segs.opp, bullet: o.segs.bullet, item: o.segs.item, global: o.segs.global };
      const p = await ask({ N: N, seed: SEED_BASE + f, mem_on: 0, segs });
      if (p && !p.err && typeof p.nodeId === 'number' && p.nodeId >= 0 && p.nodeId < N) nodeId = p.nodeId;
      await m.eval('window.__g1.setFire(' + (!NO_FIRE && p && p.fire === 1 ? 1 : 0) + ')');
    }
  }

  // 末尾：拒绝理由分布 / 放弃理由分布 / 未命中诊断
  const finalDiag = JSON.parse(await m.eval(`JSON.stringify({
    rejectReasons: (window.__vantageIface||{}).rejectReasons || {},
    giveUpReasons: (window.__vantageIface||{}).giveUpReasons || {},
    notFoundSample: (window.__vantageIface||{}).notFoundSample || null,
    notFoundEverSeen: (window.__vantageIface||{}).notFoundEverSeen,
    notFoundInReserve: (window.__vantageIface||{}).notFoundInReserve,
    iface: (function(){var I=window.__vantageIface||{};return {calls:I.calls,callsA:I.callsA,callsB:I.callsB,
      rejected:I.rejected,retries:I.retries,giveUp:I.giveUp,giveUpA:I.giveUpA,giveUpB:I.giveUpB,
      skipped:I.skipped,notFound:I.notFound,notFoundA:I.notFoundA,notFoundB:I.notFoundB,
      selectViolationRejected:I.selectViolationRejected,selectAllTrueDeadPass:I.selectAllTrueDeadPass,
      fireSelfHit:I.fireSelfHit,tickCalls:I.tickCalls,tickSkippedFull:I.tickSkippedFull,
      tickEnter:I.tickEnter,tickBail:I.tickBail};})(),
    g1: (function(){var G=window.__g1||{};return {mapApplied:G.mapApplied||0,mapNoTokN:G.mapNoTokN||0,
      rowOutOfRange:G.rowOutOfRange||0,pickFound:G.pickFound||0,pickNotFound:G.pickNotFound||0,
      mapFallback:G.mapFallback||0,routeUnreachable:G.routeUnreachable||0,fireDropN:G.fireDropN||0,
      firePicksEmpty:G.firePicksEmpty||0,firePicksN:G.firePicksN||0};})(),
    stats: (function(){var t=VantageTree.getTree();return t&&t.stats?{growRootLayerNoThreat:t.stats.growRootLayerNoThreat||0,growStepCalls:t.stats.growStepCalls||0,agentACalls:t.stats.agentACalls,
      agentBCalls:t.stats.agentBCalls,agentRouteUsed:t.stats.agentRouteUsed,
      agentSkippedFull:t.stats.agentSkippedFull,agentFireSelfHitDetected:t.stats.agentFireSelfHitDetected}:null;})()
  })`));

  const total = rows.length;
  const still = rows.filter((r) => r.op === '树:静止').length;
  const treeAny = rows.filter((r) => /^树:/.test(r.op)).length;
  const bAny = rows.filter((r) => /^B:/.test(r.op)).length;
  const rowNoop = rows.filter((r) => r.rowToUid && r.rowToUid.row === r.rowToUid.uid).length;

  const dl = (a, b) => (typeof a === 'number' && typeof b === 'number') ? (b - a) : b;
  const loopIface = { giveUpA: dl(baseSnap.is.giveUpA, finalDiag.iface.giveUpA),
    giveUpB: dl(baseSnap.is.giveUpB, finalDiag.iface.giveUpB),
    callsA: dl(baseSnap.is.callsA, finalDiag.iface.callsA), callsB: dl(baseSnap.is.callsB, finalDiag.iface.callsB),
    rejected: dl(baseSnap.is.rejected, finalDiag.iface.rejected), retries: dl(baseSnap.is.retries, finalDiag.iface.retries),
    notFound: dl(baseSnap.is.notFound, finalDiag.iface.notFound) };
  const loopG1 = {}; for (const k of Object.keys(baseSnap.g1)) loopG1[k] = dl(baseSnap.g1[k], finalDiag.g1[k]);
  console.log('===== treefix_probe [' + TAG + '] frames=' + total + ' warmup=' + WARM + ' inject=' + path.basename(INJECT) +
    ' seedBase=' + SEED_BASE + (MUTE_OPP ? ' muteOpp=1' : '') + (NO_FIRE ? ' noFire=1' : '') + ' ckpt=' + CKPT + ' =====');
  console.log('总移动帧 = ' + moved + '/' + total + '  (' + (100 * moved / total).toFixed(1) + '%)');
  console.log('控制操作不在 tree 模式的帧 = ' + ctrlNotTree + '   树这帧没 tick 的帧 = ' + deadTickFrames);
  console.log('开火输入帧 = ' + fireInputFrames + '/' + total + '   实际开火次数(fired 增量) = ' + shots +
    '   有我方子弹在飞的帧 = ' + projFrames);
  console.log('树:静止   = ' + still + '/' + total + '  (' + (100 * still / total).toFixed(1) + '%)   [判据 <5%]');
  console.log('树:* 合计 = ' + treeAny + '   B:* 合计 = ' + bAny + '   op=none 帧 = ' + opMissing);
  console.log('行号==uid 的帧 = ' + rowNoop + '/' + total + '   (≈100% ⟹ 行号→uid 映射没生效)');
  console.log('lastDesiredOp ≠ vantageControlOpName 的帧 = ' + opAppliedMismatch + '/' + total);
  console.log('输入位 ≠ 树意图对应输入位的帧 = ' + inputMismatch + '/' + total +
    (inputMismatch ? '  ' + JSON.stringify(inputMismatchByOp) : ''));
  console.log('');
  console.log('=== 按 (树的决策 | 输入有方向?) 分组 ===');
  Object.entries(byOp).sort((a, b) => b[1].n - a[1].n).forEach(([k, v]) => {
    console.log('  x' + String(v.n).padStart(3) + '  移动' + String(v.moved).padStart(3) + '  ' +
      (100 * v.n / total).toFixed(1) + '%  ' + k);
  });
  console.log('');
  console.log('=== ★ 去掉预热后的【主循环】计数（判据就看这一组）===');
  console.log(JSON.stringify(loopIface, null, 1));
  console.log('--- G1（主循环增量）---');
  console.log(JSON.stringify(loopG1, null, 1));
  console.log('=== 树意图有方向 ⟹ 真动了 的保真度 ===');
  console.log('  B:*  有方向 ' + dirB + ' 帧，真的动了 ' + dirBMoved + ' 帧  (' + (dirB ? (100 * dirBMoved / dirB).toFixed(1) : '0') + '%)');
  console.log('  树:* 有方向 ' + dirT + ' 帧，真的动了 ' + dirTMoved + ' 帧  (' + (dirT ? (100 * dirTMoved / dirT).toFixed(1) : '0') + '%)');
  // 目标节点自己的 op vs 真正被执行的那一跳的 op
  const tOp = {}, hOp = {}, diff = {};
  for (const r of rows) {
    if (!r.dbg || !r.dbg.tOp) continue;
    tOp[r.dbg.tOp] = (tOp[r.dbg.tOp] || 0) + 1;
    hOp[r.dbg.hOp] = (hOp[r.dbg.hOp] || 0) + 1;
    if (r.dbg.hOp && r.dbg.tOp !== r.dbg.hOp) diff[r.dbg.tOp + '→' + r.dbg.hOp] = (diff[r.dbg.tOp + '→' + r.dbg.hOp] || 0) + 1;
  }
  console.log('=== B 选中的【目标节点】自己的 op 分布 ===');
  Object.entries(tOp).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log('  ' + String(v).padStart(4) + '  ' + k));
  console.log('=== 真正被执行的【那一跳】的 op 分布 ===');
  Object.entries(hOp).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log('  ' + String(v).padStart(4) + '  ' + k));
  console.log('=== 目标 op ≠ 执行跳 op 的组合（树没照 B 的目标走 ⟹ 走的是"到目标的第一跳"）===');
  Object.entries(diff).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log('  ' + String(v).padStart(4) + '  ' + k));
  console.log('=== 接口计数（末尾快照，含预热）===');
  console.log(JSON.stringify(finalDiag.iface, null, 1));
  console.log('=== G1 行号→uid 诊断 ===');
  console.log(JSON.stringify(finalDiag.g1, null, 1));
  console.log('=== 树 stats ===');
  console.log(JSON.stringify(finalDiag.stats, null, 1));
  console.log('=== 未命中样本 (notFound) ===');
  console.log(JSON.stringify({ sample: finalDiag.notFoundSample, everSeen: finalDiag.notFoundEverSeen,
    inReserve: finalDiag.notFoundInReserve }, null, 1));
  console.log('=== 拒绝理由分布 (sem/format 逐条) ===');
  Object.entries(finalDiag.rejectReasons).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log('  ' + String(v).padStart(4) + '  ' + k));
  console.log('=== 放弃(重试超限)理由分布 ===');
  Object.entries(finalDiag.giveUpReasons).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log('  ' + String(v).padStart(4) + '  ' + k));
  if (argv.dump) fs.writeFileSync(argv.dump, rows.map((r) => JSON.stringify(r)).join('\n'));

  await m.close();
  srv.kill();
  process.exit(0);
})().catch((e) => { console.log('FATAL ' + ((e && e.stack) || e)); process.exit(1); });
