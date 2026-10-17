#!/usr/bin/env node
/* ============================================================================
 * 阶段 3-0 验收（权威版 §5 口径）：
 *   「`Agents.use('nn')` 但 `decide` 返回 null 时与规则版【逐帧一致】」
 *
 * 做法：同一份 RNG 带（baseline 的 `.rng.json`）+ 同一 epoch/bootFrames，
 * 在**同一进程里跑两遍**：
 *   A. 规则版（`Agents.use('rule')`）
 *   B. `Agents.use('nn')`（NNAgent 无 encode/policy ⟹ isReady=false ⟹
 *      agentSeam 直接 return，decide 从未被调用 / 返回 null）
 * 然后逐帧 diff 快照（坦克位姿/按键、子弹、制导弹 timeAlive+目标、
 * getDesiredOperation().op、commitNode、nodeCount、rng 游标…）。
 *
 * 用法：
 *   node _tools/headless/_probe_3_0_agent_null_parity.js \
 *        --baseline _tools/headless/prof/3-0_parity1200_rule.jsonl
 *
 * 只读产品代码（不写任何产品文件）。
 * ============================================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const { Match } = require('./match');

const SNAP = `(() => {
  var gc = GameManager.getGameController();
  if (!gc) return { noGc: true };
  var d = __vtData(gc.getRoundState()) || {};
  var tanks = (d.tankStates || []).map(function (t) {
    return { id: t.playerId, x: t.x, y: t.y, rot: t.rotation,
             fwd: !!t.forward, back: !!t.back, left: !!t.left, right: !!t.right, fire: !!t.fireDown };
  }).sort(function (a, b) { return a.id < b.id ? -1 : 1; });
  var msl = [];
  try {
    var ps0 = (d.projectileStates || []);
    for (var mi = 0; mi < ps0.length; mi++) {
      if (ps0[mi].type !== 3) continue;
      var live = null;
      try { live = gc.getProjectile(ps0[mi].id); } catch (eL) {}
      msl.push({ id: ps0[mi].id, x: ps0[mi].x, y: ps0[mi].y,
                 ta: (live && typeof live.getTimeAlive === 'function') ? +(+live.getTimeAlive()).toFixed(4) : null,
                 tgt: (live && live.currentTargetPlayerId !== undefined) ? live.currentTargetPlayerId : null });
    }
  } catch (eMsl) { msl = ['ERR']; }
  var projs = (d.projectileStates || []).map(function (p) { return { id: p.id, x: p.x, y: p.y }; })
    .sort(function (a, b) { return a.id < b.id ? -1 : 1; });
  var tr = null;
  try { tr = VantageTree.getTree ? VantageTree.getTree() : null; } catch (e1) { tr = null; }
  var de = null;
  try { de = VantageTree.getDesiredOperation ? VantageTree.getDesiredOperation() : null; } catch (e2) { de = null; }
  var st = (window.__vtRng && window.__vtRng.state) ? window.__vtRng.state() : null;
  var cmt = tr && tr.commitNode;
  return {
    t: window.__vt.t,
    acc: (VantageTree._coarse && VantageTree._coarse.getTimeAcc) ? VantageTree._coarse.getTimeAcc() : null,
    rng: st ? (st.mode === 'record' ? st.len : st.idx) : null,
    rngCalls: st ? st.calls : null,
    siteOverflow: st ? st.siteOverflow : null,
    op: de ? de.opName : null,
    nodes: tr ? tr.nodeCount : null,
    commit: cmt ? { id: cmt.id, op: cmt.opName, seg: cmt.segmentFrames, tEnd: cmt.tEndSec } : null,
    roundId: gc.getRoundId ? gc.getRoundId() : null,
    state: gc.getState ? gc.getState() : null,
    tanks: tanks, projs: projs, msl: msl
  };
})()`;

const TREECTL = `(() => {
  var out = { tree: null, enabled: null, ver: VantageTree.VERSION };
  try {
    var st = VantageTestbench.getState();
    out.enabled = !!(st.aiControl && st.aiControl.enabled);
    out.tree = !!(st.aiControl && st.aiControl.tree);
  } catch (e) {}
  return out;
})()`;

// 与 `_baseline_multiai_vant2_missile.js` **逐字相同**的制导弹注入（保证同一 RNG 消耗）。
const missileInjectExpr = (n) => `(() => {
  var gc = GameManager.getGameController();
  var dAll = (typeof __vtData === 'function') ? (__vtData(gc.getRoundState()) || {}) : {};
  var ids = (dAll.tankStates || []).map(function (t) { return t.playerId; });
  var A = gc.getTank('tank_a') || (ids.length ? gc.getTank(ids[0]) : null);
  var B = null;
  var aId = (typeof A.getPlayerId === 'function') ? A.getPlayerId() : (A.playerId || 'tank_a');
  if (A) { for (var ii = 0; ii < ids.length; ii++) { if (ids[ii] !== aId) { B = gc.getTank(ids[ii]); if (B) break; } } }
  if (!A) return { err: 'no tank_a' };
  var mz0 = gc.getMaze();
  var TS = (typeof Constants !== 'undefined' && Constants.TILE_SIZE) ? Constants.TILE_SIZE : 10;
  var Wm = (mz0 && mz0.getWidth ? mz0.getWidth() : 6) * TS;
  var Hm = (mz0 && mz0.getHeight ? mz0.getHeight() : 5) * TS;
  var dirs = [[1, 0], [0, 1], [-1, 0], [0, -1]];
  var dv = dirs[(${n} - 1) % dirs.length];
  var dx = dv[0], dy = dv[1];
  var d = Math.sqrt(dx * dx + dy * dy) || 1; dx /= d; dy /= d;
  var id = 'probe_base_missile_' + ${n};
  var x = Wm * 0.5 + dx * 1.5, y = Hm * 0.5 + dy * 1.5;
  var ps = ProjectileState.withState(id, 'tank_a', 3, x, y, dx * 18, dy * 18);
  gc.roundController.setProjectileState(ps);
  var p = gc.getProjectile(id);
  return { ok: !!p, id: p ? p.getId() : null, type: p ? p.getType() : null,
           tgt: p ? p.currentTargetPlayerId : null, x: p ? p.getX() : null, y: p ? p.getY() : null,
           t: window.__vt.t };
})()`;

function near(a, b, eps) {
  if (a === b) return true;
  if (typeof a === 'number' && typeof b === 'number') {
    if (!isFinite(a) || !isFinite(b)) return a === b;
    return Math.abs(a - b) <= eps;
  }
  return false;
}
function diffSnap(a, b, eps) {
  const out = [];
  for (const k of ['tRel', 'acc', 'rng', 'rngCalls', 'siteOverflow', 'op', 'nodes', 'roundId', 'state']) {
    if (!near(a[k], b[k], eps)) out.push({ path: k, a: a[k], b: b[k] });
  }
  const ca = a.commit || {}, cb = b.commit || {};
  for (const k of ['id', 'op', 'seg', 'tEnd']) {
    if (!near(ca[k], cb[k], eps)) out.push({ path: 'commit.' + k, a: ca[k], b: cb[k] });
  }
  const ta = a.tanks || [], tb = b.tanks || [];
  if (ta.length !== tb.length) out.push({ path: 'tanks.len', a: ta.length, b: tb.length });
  else for (let i = 0; i < ta.length; i++) {
    for (const k of ['id', 'x', 'y', 'rot', 'fwd', 'back', 'left', 'right', 'fire']) {
      if (!near(ta[i][k], tb[i][k], eps)) out.push({ path: 'tanks[' + i + '].' + k, a: ta[i][k], b: tb[i][k] });
    }
  }
  const ma = JSON.stringify(a.msl || []), mb = JSON.stringify(b.msl || []);
  if (ma !== mb) out.push({ path: 'msl', a: (a.msl || []).length, b: (b.msl || []).length });
  const pa = a.projs || [], pb = b.projs || [];
  if (pa.length !== pb.length) out.push({ path: 'projs.len', a: pa.length, b: pb.length });
  else for (let i = 0; i < pa.length; i++) {
    for (const k of ['id', 'x', 'y']) {
      if (!near(pa[i][k], pb[i][k], eps)) out.push({ path: 'projs[' + i + '].' + k, a: pa[i][k], b: pb[i][k] });
    }
  }
  return out;
}

async function runEpisode(opts) {
  const m = new Match();
  const openOpts = {
    humanIds: ['tank_a'], aiCount: opts.ai, vantCount: opts.vant,
    rng: opts.rngSeq ? 'play' : 'record', bootFrames: opts.bootFrames || 300, rebaseAtMenu: true
  };
  if (opts.rngSeq) openOpts.rngSeq = opts.rngSeq;
  if (opts.epoch !== undefined && opts.epoch !== null) openOpts.epoch = opts.epoch;
  await m.open(openOpts);
  const ctl = await m.eval(TREECTL);
  const tOpen = await m.eval('window.__vt.t');
  // ★ 切智能体：必须在任何 pump(1) 之前（op 之后、首帧之前）。
  const agentName = await m.eval(opts.agentNull
    ? '(function(){var I=VantageTreeInterface; I.Agents.register(new I.NNAgent({})); I.Agents.use("nn"); return I.Agents.current().name;})()'
    : '(function(){var I=VantageTreeInterface; I.Agents.use("rule"); return I.Agents.current().name;})()');
  const rows = [];
  for (let f = 1; f <= opts.frames; f++) {
    await m.pump(1);
    if (opts.missileFrames && opts.missileFrames.indexOf(f) >= 0) {
      await m.eval(missileInjectExpr(opts.missileFrames.indexOf(f) + 1));
    }
    const s = await m.eval(SNAP);
    s.tRel = s.t - tOpen;
    rows.push({ f, snap: s });
  }
  const iface = await m.eval('(window.__vantageIface ? {calls: window.__vantageIface.calls, skipped: window.__vantageIface.skipped, giveUp: window.__vantageIface.giveUp, retries: window.__vantageIface.retries, tickCalls: window.__vantageIface.tickCalls} : null)');
  const rng = await m.eval('({ seq: window.__vtRng.dump(), state: window.__vtRng.state() })');
  await m.close();
  return { rows, ctl, tOpen, agentName, iface, rng, menuFrames: m.menuFrames, bootFrames: m.bootFrames };
}

(async () => {
  const argv = process.argv.slice(2);
  const arg = (n, d) => { const i = argv.indexOf('--' + n); return i < 0 ? d : argv[i + 1]; };
  const baseline = path.resolve(arg('baseline', path.join(__dirname, 'prof', '_multiai_vant2_missile_v179.jsonl')));
  const base = fs.readFileSync(baseline, 'utf8').split('\n').filter((l) => l.length).map((l) => JSON.parse(l));
  const header = base[0];
  const tape = JSON.parse(fs.readFileSync(baseline.replace(/\.jsonl$/, '') + '.rng.json', 'utf8'));
  const frames = Number(arg('frames', header.frames));
  const eps = 1e-12;
  const missileFrames = (header.missileFrames && header.missileFrames.length) ? header.missileFrames : [];

  console.log('=== 3-0 §5 验收：Agents.use("nn")（decide→null） vs 规则版 逐帧一致 ===');
  console.log('  baseline=' + baseline + '  frames=' + frames + '  tapeLen=' + tape.seq.length +
    '  missileFrames=' + JSON.stringify(missileFrames));
  const common = { frames, vant: header.vant, ai: header.ai, rngSeq: tape.seq, epoch: header.epoch,
    bootFrames: header.bootFrames || 300, missileFrames };
  const A = await runEpisode(Object.assign({}, common, { agentNull: false }));
  const B = await runEpisode(Object.assign({}, common, { agentNull: true }));
  console.log('  A agent=' + A.agentName + ' iface=' + JSON.stringify(A.iface));
  console.log('  B agent=' + B.agentName + ' iface=' + JSON.stringify(B.iface));

  let bad = 0, firstBad = null;
  const fieldCount = {};
  for (let i = 0; i < Math.min(A.rows.length, B.rows.length); i++) {
    const d = diffSnap(A.rows[i].snap, B.rows[i].snap, eps);
    if (d.length) {
      bad++;
      for (const x of d) fieldCount[x.path] = (fieldCount[x.path] || 0) + 1;
      if (!firstBad) firstBad = { f: A.rows[i].f, diffs: d.slice(0, 8) };
    }
  }
  const overflow = B.rng.state.overflow;
  console.log('  不一致帧数=' + bad + '/' + Math.min(A.rows.length, B.rows.length) +
    '  分歧字段=' + JSON.stringify(fieldCount) + '  replayOverflowB=' + overflow);
  if (firstBad) console.log('  首个分歧 f=' + firstBad.f + ' ' + JSON.stringify(firstBad.diffs));
  const ok = bad === 0 && overflow === 0 && B.agentName === 'nn' && A.agentName === 'rule';
  console.log('\n' + (ok ? '3-0 AGENT-NULL PARITY PASSED' : '3-0 AGENT-NULL PARITY FAILED'));
  if (!ok) process.exitCode = 1;
})().catch((e) => { console.error('AGENT-NULL PARITY FAILED: ' + ((e && e.stack) || e)); process.exitCode = 1; });
