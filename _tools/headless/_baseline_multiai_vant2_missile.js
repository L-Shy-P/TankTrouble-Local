'use strict';
/* 多 vantage（vant=2 + Laika）固定 RNG 逐帧基线（2026-10-12）
 *
 * 目的：证明「多 vantage 同局」下树决策/世界状态逐帧可复现；作为以后改
 *       vantage_tree.js / wasm 时"有没有把多 AI 场景改漂"的对照基线。
 *
 *   # 录基线（只在确实要重建基线时跑；会覆盖）
 *   node _tools/headless/_baseline_multiai_vant2.js --mode record --frames 600 \
 *        --out _tools/headless/prof/_multiai_vant2_baseline.jsonl
 *
 *   # 验证（任何改动 vantage_tree.js / wasm 之后都跑这条）
 *   node _tools/headless/_baseline_multiai_vant2.js --mode verify \
 *        --baseline _tools/headless/prof/_multiai_vant2_baseline.jsonl
 *
 * 判据：同一 RNG 带重放，每一帧的
 *   t / acc(_timeAcc) / rng消费游标 / 两辆 vantage+对手的位姿与按键 / 子弹位姿 /
 *   getDesiredOperation().op / commitNode(id,op,seg,tEnd) / nodeCount / roundId / gcState
 * 全部一致（数值容差 1e-12）。任何一帧不一致 → exit 1 并打印首个分歧帧。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Match } = require('./match');

const SNAP = `(() => {
  var gc = GameManager.getGameController();
  if (!gc) return { noGc: true };
  var d = __vtData(gc.getRoundState()) || {};
  var tanks = (d.tankStates || []).map(function (t) {
    return { id: t.playerId, x: t.x, y: t.y, rot: t.rotation,
             fwd: !!t.forward, back: !!t.back, left: !!t.left, right: !!t.right, fire: !!t.fireDown };
  }).sort(function (a, b) { return a.id < b.id ? -1 : 1; });
  // 2026-10-14（收尾①）：制导弹状态也进快照 —— 光有位置证明不了「真制导过」
  var msl = [];
  try {
    var ps0 = (d.projectileStates || []);
    for (var mi = 0; mi < ps0.length; mi++) {
      if (ps0[mi].type !== 3) continue;
      var mf = {};
      try { mf = JSON.parse(ps0[mi].fieldsJSON || '{}'); } catch (eM) {}
      // ★ timeAlive / currentTargetPlayerId 不在序列化的 fieldsJSON 里，
      //   必须从**活对象**取（上一版我读 fieldsJSON～全是 null，已修）。
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
    rngSites: st ? st.siteCount : null,
    siteOverflow: st ? st.siteOverflow : null,
    op: de ? de.opName : null,
    nodes: tr ? tr.nodeCount : null,
    commit: cmt ? { id: cmt.id, op: cmt.opName, seg: cmt.segmentFrames, tEnd: cmt.tEndSec } : null,
    roundId: gc.getRoundId ? gc.getRoundId() : null,
    state: gc.getState ? gc.getState() : null,
    tanks: tanks, projs: projs,
    msl: msl
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

// 2026-10-14（1-2④ 收尾①）：制导弹注入 + 证据。
const missileInjectExpr = (n) => `(() => {
  var gc = GameManager.getGameController();
  // ⚠️ 本基线的玩家是 tank_a + Laika + vantage_1/2（**没有 tank_b**）
  //   ⇒ 必须从真实 player 列表里挑第二辆（上一版写死 tank_b 导致 3 发全部注入失败）
  var dAll = (typeof __vtData === 'function') ? (__vtData(gc.getRoundState()) || {}) : {};
  var ids = (dAll.tankStates || []).map(function (t) { return t.playerId; });
  var A = gc.getTank('tank_a') || (ids.length ? gc.getTank(ids[0]) : null);
  var B = null;
  var aId = (typeof A.getPlayerId === 'function') ? A.getPlayerId() : (A.playerId || 'tank_a');
  if (A) { for (var ii = 0; ii < ids.length; ii++) { if (ids[ii] !== aId) { B = gc.getTank(ids[ii]); if (B) break; } } }
  if (!A) return { err: 'no tank_a' };
  // ★ 目的：让制导弹**活过 2.0s 激活门**。
  //   上一版从 tank_a 旁边向左飞，111 帧（ta=1.833）就撞上坦克死了 ⇒ 根本没制导。
  //   这一版：从「背离 B 的那一侧」出去、速度指向更远处（离两车都远）。
  // ⚠️ 上一版：用「背离 B」方向 → 弹被放到**迷宫外**（x≈-3），
  //   飞出去一直不回来，maze.getDistancesFromPosition 失败 ⇒ **ta>2.0 却从未制导**。
  //   这一版：一律放在**迷宫正中心**，三发朝不同方向 ⇒ 一定在图内、且 2s 后必定能选到目标。
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

const MISSILE_EVIDENCE = `(() => {
  var gc = GameManager.getGameController();
  var d = __vtData(gc.getRoundState()) || {};
  var ps = (d.projectileStates || []);
  var mine = [];
  for (var i = 0; i < ps.length; i++) {
    var f = {};
    try { f = JSON.parse(ps[i].fieldsJSON || '{}'); } catch (e) {}
    if (ps[i].type === 3) {
      mine.push({ id: ps[i].id, owner: ps[i].playerId, x: +(+ps[i].x).toFixed(3), y: +(+ps[i].y).toFixed(3),
                  ta: (f._timeAlive == null ? null : +(+f._timeAlive).toFixed(4)), tgt: f.currentTargetPlayerId });
    }
  }
  return { t: window.__vt.t, missileCount: mine.length, missiles: mine,
           treeVersion: (typeof VantageTree !== 'undefined' && VantageTree.VERSION) ? VantageTree.VERSION : null,
           abiVersion: (function(){ try { return VantageRustBridge.version(); } catch (e) { return String((e&&e.message)||e); } })() };
})()`;

const md5 = (f) => { try { return crypto.createHash('md5').update(fs.readFileSync(f)).digest('hex'); } catch (e) { return null; } };
const root = path.join(__dirname, '..', '..');
const treeFile = path.join(root, 'game_core', 'js', 'vantage_tree.js');
const sandboxFile = path.join(root, 'game_core', 'js', 'vantage_sandbox.js');

function near(a, b, eps) {
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) <= eps;
  return a === b;
}

/** 返回 [{path,a,b}]；空数组 = 一致 */
function diffSnap(a, b, eps) {
  const out = [];
  // ⚠️ rngSites 只在 record 模式收集（play 模式恒 0）——只记录不对拍；siteOverflow 两边都可比。
  const scal = ['tRel', 'acc', 'rng', 'rngCalls', 'siteOverflow', 'op', 'nodes', 'roundId', 'state'];
  for (const k of scal) if (!near(a[k], b[k], eps)) out.push({ path: k, a: a[k], b: b[k] });
  const ca = a.commit || {}, cb = b.commit || {};
  for (const k of ['id', 'op', 'seg', 'tEnd']) if (!near(ca[k], cb[k], eps)) out.push({ path: 'commit.' + k, a: ca[k], b: cb[k] });
  const ta = a.tanks || [], tb = b.tanks || [];
  if (ta.length !== tb.length) out.push({ path: 'tanks.len', a: ta.length, b: tb.length });
  else for (let i = 0; i < ta.length; i++) {
    for (const k of ['id', 'x', 'y', 'rot', 'fwd', 'back', 'left', 'right', 'fire']) {
      if (!near(ta[i][k], tb[i][k], eps)) out.push({ path: 'tanks[' + i + '].' + k, a: ta[i][k], b: tb[i][k] });
    }
  }
  // 2026-10-14：制导弹状态（位置/timeAlive/目标）—— 两边都有才比（旧录制无此字段不受影响）
  if (a.msl !== undefined || b.msl !== undefined) {
    const ma = JSON.stringify(a.msl || []), mb = JSON.stringify(b.msl || []);
    if (ma !== mb) { out.push({ path: 'msl', a: (a.msl || []).length, b: (b.msl || []).length }); out.ok = false; }
  }
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
  // ★ 与 record.js 同款确定性启动：bootFrames 把"资产/Menu 阶段到建局"的帧数钉死，
  //   锁 epoch（主题/种子吃 Date），并在 open 内部复基 timer + 清 Phaser 累加器残差。
  const openOpts = { humanIds: ['tank_a'], aiCount: opts.ai, vantCount: opts.vant,
    rng: opts.rngSeq ? 'play' : 'record', bootFrames: opts.bootFrames || 300, rebaseAtMenu: true };
  if (opts.rngSeq) openOpts.rngSeq = opts.rngSeq;
  if (opts.epoch !== undefined && opts.epoch !== null) openOpts.epoch = opts.epoch;
  await m.open(openOpts);
  const ctl = await m.eval(TREECTL);
  const tOpen = await m.eval('window.__vt.t');
  const epoch = await m.eval('window.__vt.epoch');
  const rows = [];
  // 2026-10-14（1-2④ 收尾①）：可选的「真制导弹在场」注入。
  //   `--missile-frame N` 表示第 N 帧（帧号从 1 起）用游戏自己的
  //   `ProjectileState.withState` 工厂在 tank_a 旁边放一发 `type=3`（HOMING_MISSILE）。
  //   工厂路径已实测与「真开火」逐字节相同（《导弹制导实测-2026-10-12》§五）。
  //   record/verify 两模式都在同一帧注入 ⇒ 自动对拍。
  let missileEvidence = null;
  for (let f = 1; f <= opts.frames; f++) {
    await m.pump(1);
    if (opts.missileFrames && opts.missileFrames.indexOf(f) >= 0) {
      const inject = await m.eval(missileInjectExpr(opts.missileFrames.indexOf(f) + 1));
      if (!missileEvidence) missileEvidence = [];
      missileEvidence.push({ f: f, inject: inject });
    }
    const s = await m.eval(SNAP);
    s.tRel = s.t - tOpen;      // 绝对 t 含启动帧数；对拍用相对时间
    rows.push({ f: f, snap: s });
  }
  // 收尾：把制导弹的「真在场 + 真制导过」证据拿出来（不进快照格式）
  const missileFinal = await m.eval(MISSILE_EVIDENCE);
  const rng = await m.eval('({ seq: window.__vtRng.dump(), state: window.__vtRng.state() })');
  await m.close();
  return { rows: rows, ctl: ctl, rng: rng, tOpen: tOpen, epoch: epoch,
    menuFrames: m.menuFrames, bootPadded: m.bootPadded, bootFrames: m.bootFrames,
    missileInject: missileEvidence, missileFinal: missileFinal };
}

(async () => {
  const argv = process.argv.slice(2);
  const num = (n, d) => { const i = argv.indexOf('--' + n); return i < 0 ? d : Number(argv[i + 1]); };
  const str = (n, d) => { const i = argv.indexOf('--' + n); return i < 0 ? d : argv[i + 1]; };
  const mode = str('mode', 'verify');
  const frames = num('frames', 600);
  const vant = num('vant', 2), ai = num('ai', 1);
  const out = str('out', path.join(__dirname, 'prof', '_multiai_vant2_baseline.jsonl'));
  // ★ 2026-10-13：verify 的**默认基线**指向当前口径（testbench v104：maxNodes=1000/nodeCap=true/
  //   horizonSec=10/refineBeyond=false，tree v179 录制）。
  //   旧基线 `_multiai_vant2_missile.jsonl`（旧 DEFAULT_EXP 时代）**并存保留**，
  //   它是"换回旧 testbench ⟹ 0/600 PASS"这条 A/B 因果证明的证据，勿删；
  //   要用旧基线请显式 `--baseline _tools/headless/prof/_multiai_vant2_missile.jsonl`。
  //   同目录 `_multiai_vant2_missile.BASELINE-NOTE.md` 写清了两者对应关系。
  //   ⚠️ record 模式的 `--out` 默认仍是 `_multiai_vant2_baseline.jsonl`（非本脚本产物）；
  //      重录本场景必须显式给 `--out .../_multiai_vant2_missile_v179.jsonl --missile-frames 60,120,180`。
  const base = str('baseline', path.join(__dirname, 'prof', '_multiai_vant2_missile_v179.jsonl'));
  const eps = 1e-12;
  const missileFrame = num('missile-frame', 0);   // 0 = 不注入（保持旧行为）
  const missileFrames = str('missile-frames', '').split(',').map((x) => Number(x)).filter((x) => x > 0);
  const mfList = missileFrames.length ? missileFrames : (missileFrame ? [missileFrame] : []);

  if (mode === 'record') {
    const t0 = Date.now();
    const r = await runEpisode({ frames: frames, vant: vant, ai: ai, rngSeq: null, missileFrames: mfList, missileFrame: missileFrame });
    const header = {
      k: 'header', v: 1, treeVersion: r.ctl.ver, treeMd5: md5(treeFile), sandboxMd5: md5(sandboxFile),
      vant: vant, ai: ai, frames: frames, rngLen: r.rng.seq.length, rngOverflow: r.rng.state.overflow,
      epoch: r.epoch, tOpen: r.tOpen, bootFrames: r.bootFrames, menuFrames: r.menuFrames, bootPadded: r.bootPadded,
      aiControl: r.ctl, date: new Date().toISOString(), wallMs: Date.now() - t0,
      missileFrame: missileFrame, missileFrames: mfList
    };
    const rngFile = base.replace(/\.jsonl$/, '') + '.rng.json';
    const metaFile = base.replace(/\.jsonl$/, '') + '.meta.json';
    fs.mkdirSync(path.dirname(base), { recursive: true });
    fs.writeFileSync(base, JSON.stringify(header) + '\n' + r.rows.map((x) => JSON.stringify(x)).join('\n') + '\n');
    fs.writeFileSync(rngFile, JSON.stringify({ seq: r.rng.seq, state: r.rng.state }));
    fs.writeFileSync(metaFile, JSON.stringify(header, null, 1));
    console.log('RECORD OK ' + JSON.stringify({ file: base, rngFile: rngFile, metaFile: metaFile, frames: r.rows.length,
      treeVersion: header.treeVersion, treeMd5: header.treeMd5, rngLen: header.rngLen, rngOverflow: header.rngOverflow,
      aiControl: r.ctl, wallMs: header.wallMs }));
    console.log('  MISSILE-INJECT ' + JSON.stringify(r.missileInject));
    console.log('  MISSILE-FINAL  ' + JSON.stringify(r.missileFinal));
    return;
  }

  // verify：读冻结基线 + 同一条 RNG 带重放 → 逐帧对拍
  const lines = fs.readFileSync(base, 'utf8').split('\n').filter((l) => l.length);
  const header = JSON.parse(lines[0]);
  const want = lines.slice(1).map((l) => JSON.parse(l));
  const rngFile = base.replace(/\.jsonl$/, '') + '.rng.json';
  const tape = JSON.parse(fs.readFileSync(rngFile, 'utf8'));
  const r = await runEpisode({ frames: want.length, vant: header.vant, ai: header.ai, rngSeq: tape.seq,
    missileFrames: (header.missileFrames && header.missileFrames.length ? header.missileFrames : mfList),
    epoch: header.epoch, bootFrames: header.bootFrames || 300 });
  let bad = 0, firstBad = null;
  const fieldCount = {};
  for (let i = 0; i < want.length; i++) {
    const d = diffSnap(want[i].snap, r.rows[i].snap, eps);
    if (d.length) {
      bad++;
      for (const x of d) fieldCount[x.path] = (fieldCount[x.path] || 0) + 1;
      if (!firstBad) firstBad = { f: want[i].f, diffs: d.slice(0, 8) };
    }
  }
  const overflow = r.rng.state.overflow;
  const ok = bad === 0 && overflow === 0;
  console.log('VERIFY ' + (ok ? 'PASS' : 'FAIL'));
  console.log('  baseline=' + base + ' treeVersion=' + header.treeVersion + ' treeMd5(录制时)=' + header.treeMd5);
  console.log('  treeMd5(现在)=' + md5(treeFile) + '  frames=' + want.length + '  rngLen=' + tape.seq.length +
    ' replayOverflow=' + overflow + ' aiControl=' + JSON.stringify(r.ctl));
  console.log('  epoch(录制/现在)=' + header.epoch + ' / ' + r.epoch +
    '  bootFrames(录制/现在)=' + header.bootFrames + ' / ' + r.bootFrames +
    '  menuFrames(录制/现在)=' + header.menuFrames + ' / ' + r.menuFrames);
  console.log('  不一致帧数=' + bad + '/' + want.length + '  分歧字段=' + JSON.stringify(fieldCount));
  if (firstBad) console.log('  首个分歧 f=' + firstBad.f + ' ' + JSON.stringify(firstBad.diffs));
  console.log('  MISSILE-INJECT ' + JSON.stringify(r.missileInject));
  console.log('  MISSILE-FINAL  ' + JSON.stringify(r.missileFinal));
  if (!ok) process.exitCode = 1;
})().catch((e) => { console.error('BASELINE FAILED: ' + ((e && e.stack) || e)); process.exitCode = 1; });
