'use strict';
/**
 * 阶段 1′ 通宵训练 —— Rollout Worker
 * ==================================================================
 * 三个关键优化（针对实测出的瓶颈）：
 *  ① 整个 episode 在【页面内】跑完 —— CDP 往返从「每步 1 次」降到「每局 1 次」（20x）
 *  ② stub 掉 renderer.render —— 无头模式下 SwiftShader 软件光栅化纯属白干
 *  ③ 一个浏览器开多个 page 并行 —— 每个 page 独立物理世界，零干扰
 *
 * 用法（一般由 tools/nn/stage1_ppo.py 调用，不直接手跑）：
 *   node _tools/headless/rollout_worker.js --pages 4 --episodes 40 --weights w.json --out d.jsonl
 */
const fs = require('fs');
const path = require('path');
const { launch, sleep } = require('./cdp');
const { startPyServer } = require('./pyserver');

function arg(n, d) { const i = process.argv.indexOf('--' + n); return i < 0 ? d : Number(process.argv[i + 1]); }
function argS(n, d) { const i = process.argv.indexOf('--' + n); return i < 0 ? d : process.argv[i + 1]; }

const TILE = 10;
const OBS_DIM = 12;
const NACT = 9;

/* ---------------- 页面内注入的代码 ---------------- */
const PAGE_CODE = `
window.__vt = window.__vt || {};

// ---------- 极简 MLP（Float32 手写，不含反向）----------
// 结构: obs(12) -> 64 -> 64 -> {logits(9), value(1)}
window.__vtNet = function (w) {
  var p = 0;
  function take(n) { var a = w.subarray(p, p + n); p += n; return a; }
  return {
    w1: take(12 * 64), b1: take(64),
    w2: take(64 * 64), b2: take(64),
    w3: take(64 * 9), b3: take(9),
    w4: take(64 * 1), b4: take(1),
  };
};
function linear(x, w, b, nin, nout, out) {
  for (var o = 0; o < nout; o++) {
    var s = b[o], base = o;                 // w 是 [nout, nin] 行主序
    for (var i = 0; i < nin; i++) s += x[i] * w[base * nin + i];
    out[o] = s;
  }
}
window.__vtFwd = function (net, obs) {
  var h1 = new Float32Array(64), h2 = new Float32Array(64);
  var lg = new Float32Array(9), vv = new Float32Array(1);
  linear(obs, net.w1, net.b1, 12, 64, h1);
  for (var i = 0; i < 64; i++) if (h1[i] < 0) h1[i] = 0;
  linear(h1, net.w2, net.b2, 64, 64, h2);
  for (var j = 0; j < 64; j++) if (h2[j] < 0) h2[j] = 0;
  linear(h2, net.w3, net.b3, 64, 9, lg);
  linear(h2, net.w4, net.b4, 64, 1, vv);
  return { logits: lg, value: vv[0] };
};
window.__vtSample = function (logits, temp) {
  var mx = -1e30, k;
  for (k = 0; k < 9; k++) if (logits[k] > mx) mx = logits[k];
  var s = 0, pr = new Float32Array(9);
  for (k = 0; k < 9; k++) { pr[k] = Math.exp((logits[k] - mx) / temp); s += pr[k]; }
  var r = Math.random() * s, acc = 0, a = 8;
  for (k = 0; k < 9; k++) { acc += pr[k]; if (r <= acc) { a = k; break; } }
  return { a: a, logp: Math.log(pr[a] / s) };
};

// ---------- 观测 ----------
window.__vtObs = function (ax, ay, rot, bx, by) {
  var dx = bx - ax, dy = by - ay;
  var dist = Math.sqrt(dx * dx + dy * dy);
  var bear = Math.atan2(dy, dx);
  var rel = bear - rot;
  while (rel > Math.PI) rel -= 2 * Math.PI;
  while (rel < -Math.PI) rel += 2 * Math.PI;
  // 前向向量（游戏里 rot=0 朝 -y）
  var fx = Math.sin(rot), fy = -Math.cos(rot);
  var fwdDot = (dx * fx + dy * fy) / (dist + 1e-6);
  var o = new Float32Array(12);
  o[0] = ax / 100; o[1] = ay / 100; o[2] = Math.sin(rot); o[3] = Math.cos(rot);
  o[4] = bx / 100; o[5] = by / 100;
  o[6] = dx / 100; o[7] = dy / 100;
  o[8] = dist / 100; o[9] = Math.sin(rel); o[10] = Math.cos(rel);
  o[11] = fwdDot;
  return o;
};

window.__vtAct = function (a) {
  var c = window.__vtCtrl;
  c.fwd = !!(a === 1 || a === 5 || a === 6);
  c.back = !!(a === 2 || a === 7 || a === 8);
  c.left = !!(a === 3 || a === 5 || a === 7);
  c.right = !!(a === 4 || a === 6 || a === 8);
  return 1;
};

// ---------- 一局 ----------
window.__vtEpisode = function (net, A, B, steps, seg, temp) {
  var gc = GameManager.getGameController();
  var id = window.__vtTankId;
  // 传送
  if (!window.__vtNoTeleport) {
    gc.setTankState(TankState.withState(id, A.x, A.y, false, false, A.rot, false, false, false, false), false);
    for (var z0 = 0; z0 < 3; z0++) window.__vtStep(1);
  }
  if (window.__vtNoTeleport) window.__vtCtrl.fwd = true;   // 强制前进，看会不会动
  var t = gc.getTank(id);
  if (!t) return null;
  var ax0 = t.getX(), ay0 = t.getY();
  var ax = ax0, ay = ay0, rot = t.getRotation();
  var traj = [];
  var prevD = Math.sqrt((ax - B.x) * (ax - B.x) + (ay - B.y) * (ay - B.y));
  var alive = true;
  var pathLen = 0;   // 累计每步实际位移（moved 是净位移，随机策略来回走会互相抵消）
  for (var s = 0; s < steps; s++) {
    var ox = ax, oy = ay;
    var obs = window.__vtObs(ax, ay, rot, B.x, B.y);
    var f = window.__vtFwd(net, obs);
    var smp = window.__vtSample(f.logits, temp);
    window.__vtAct(smp.a);
    // clock.js 修好后逐帧/一次性等价；保留逐帧只为保持原有执行顺序
    for (var zf = 0; zf < seg; zf++) window.__vtStep(1);
    var t2 = gc.getTank(id);
    if (!t2) { traj.push({ obs: Array.from(obs), a: smp.a, logp: smp.logp, v: f.value, r: -5, done: 1 }); alive = false; break; }
    ax = t2.getX(); ay = t2.getY(); rot = t2.getRotation();
    pathLen += Math.sqrt((ax - ox) * (ax - ox) + (ay - oy) * (ay - oy));
    var d = Math.sqrt((ax - B.x) * (ax - B.x) + (ay - B.y) * (ay - B.y));
    var r = (prevD - d) / 10;                       // 势能塑形，单位=格
    prevD = d;
    traj.push({ obs: Array.from(obs), a: smp.a, logp: smp.logp, v: f.value, r: r, done: 0 });
  }
  window.__vtCtrl.fwd = window.__vtCtrl.back = window.__vtCtrl.left = window.__vtCtrl.right = false;
  // 最终到目标的迷宫距离（任务指标）——回合刚结束 maze 可能为 null，要防一手
  var mz = gc.getMaze();
  var md = false;
  if (mz) {
    try {
      md = mz.getDistanceBetweenPositions(
        { x: Math.floor(ax / ${TILE}), y: Math.floor(ay / ${TILE}) },
        { x: Math.floor(B.x / ${TILE}), y: Math.floor(B.y / ${TILE}) });
    } catch (eMd) { md = false; }
  }
  var mv = Math.sqrt((ax-ax0)*(ax-ax0)+(ay-ay0)*(ay-ay0));
  return { traj: traj, moved: mv, path: pathLen, steps: traj.length,
           ax0: ax0, ay0: ay0, finalEuclid: prevD / 10, finalMaze: (md === false ? -1 : md),
           ax: ax, ay: ay, dead: !alive };
};


// ============================================================
// 旧 async 版 batch（保留作对照，默认不用）
//
// 早期观察到「帧间 setTimeout 让出真实时间 → 坦克会动」，那只是因为当时
// clock.js 没接管 Date 构造函数，而 GameController.update() 用 new Date()
// 取真实墙钟：让出真实时间 → dt>0 → 会动。真正的修复在 clock.js：把 Date
// 也虚拟化后，同步紧循环的 dt 精确 = 16.667ms/帧，位移完全正确。
// 所以默认路径已改回一次 evaluate 跑完的同步 __vtBatch（快且确定），
// 这个 async 版本仅为历史对照保留。
// ============================================================
window.__vtBatchAsync = async function (wArr, nEp, steps, seg, temp, cand, minSep, frameMs, getReady) {
  var w = new Float32Array(wArr);
  var net = window.__vtNet(w);
  var yieldFn = function () { return new Promise(function (r) { setTimeout(r, frameMs); }); };
  var gc = GameManager.getGameController();
  var id = window.__vtTankId;
  var out = [];
  var guard = 0;
  while (out.length < nEp && guard++ < nEp * 6) {
    var A = cand[(Math.random() * cand.length) | 0];
    var B = cand[(Math.random() * cand.length) | 0];
    var sep = Math.sqrt((A.x - B.x) * (A.x - B.x) + (A.y - B.y) * (A.y - B.y));
    if (sep < minSep) continue;

    // 等回合就绪（回合有时间限制，结束后 setInputState 会被整段丢弃）
    var ready = false;
    for (var w8 = 0; w8 < 120; w8++) {
      if (window.__vtReady && window.__vtReady()) { ready = true; break; }
      window.__vtStep(1); await yieldFn();
    }
    if (!ready) continue;

    var A2 = { x: A.x, y: A.y, rot: Math.random() * 6.283 };
    var r = await window.__vtEpisodeAsync(net, A2, B, steps, seg, temp, yieldFn);
    if (r) out.push(r);
  }
  return out;
};

window.__vtEpisodeAsync = async function (net, A, B, steps, seg, temp, yieldFn) {
  var gc = GameManager.getGameController();
  var id = window.__vtTankId;
  gc.setTankState(TankState.withState(id, A.x, A.y, false, false, A.rot, false, false, false, false), false);
  for (var z0 = 0; z0 < 3; z0++) { window.__vtStep(1); await yieldFn(); }

  var t = gc.getTank(id);
  if (!t) return null;
  var ax0 = t.getX(), ay0 = t.getY();
  var ax = ax0, ay = ay0, rot = t.getRotation();
  var traj = [];
  var prevD = Math.sqrt((ax - B.x) * (ax - B.x) + (ay - B.y) * (ay - B.y));
  var alive = true;
  var pathLen = 0;   // ★ 累计每步实际位移（net displacement 会被来回走的随机策略抵消，这个不会）

  for (var s = 0; s < steps; s++) {
    var ox = ax, oy = ay;
    var obs = window.__vtObs(ax, ay, rot, B.x, B.y);
    var f = window.__vtFwd(net, obs);
    var smp = window.__vtSample(f.logits, temp);
    window.__vtAct(smp.a);
    for (var zf = 0; zf < seg; zf++) { window.__vtStep(1); await yieldFn(); }

    var t2 = gc.getTank(id);
    if (!t2) { traj.push({ obs: Array.from(obs), a: smp.a, logp: smp.logp, v: f.value, r: -5, done: 1 }); alive = false; break; }
    ax = t2.getX(); ay = t2.getY(); rot = t2.getRotation();
    pathLen += Math.sqrt((ax - ox) * (ax - ox) + (ay - oy) * (ay - oy));
    var d = Math.sqrt((ax - B.x) * (ax - B.x) + (ay - B.y) * (ay - B.y));
    var rw = (prevD - d) / 10;
    prevD = d;
    traj.push({ obs: Array.from(obs), a: smp.a, logp: smp.logp, v: f.value, r: rw, done: 0 });
  }
  window.__vtCtrl.fwd = window.__vtCtrl.back = window.__vtCtrl.left = window.__vtCtrl.right = false;

  var mz = gc.getMaze();
  var md = mz.getDistanceBetweenPositions(
    { x: Math.floor(ax / 10), y: Math.floor(ay / 10) },
    { x: Math.floor(B.x / 10), y: Math.floor(B.y / 10) });
  return { traj: traj, moved: Math.sqrt((ax - ax0) * (ax - ax0) + (ay - ay0) * (ay - ay0)),
           path: pathLen, steps: traj.length,
           ax0: ax0, ay0: ay0, finalEuclid: prevD / 10, finalMaze: (md === false ? -1 : md),
           ax: ax, ay: ay, dead: !alive };
};

// ---------- 单段：设控制 + 逐帧推进 + 返回状态 ----------
// 注：现在一次 __vtStep(frames) 与逐帧等价 —— 只要 clock.js 把 Date 构造函数
//   也虚拟化了。之前「一口气跑坦克不动」的根因是 GameController.update() 用
//   new Date() 取真实墙钟，紧循环里帧间真实耗时≈0 → dt≈0；与「事件循环堵死」无关。
window.__vtSeg = function (ctrl, frames, tx, ty) {
  var c = window.__vtCtrl;
  c.fwd=!!ctrl.fwd; c.back=!!ctrl.back; c.left=!!ctrl.left; c.right=!!ctrl.right;
  for (var f = 0; f < frames; f++) window.__vtStep(1);
  var gc = GameManager.getGameController();
  var t = gc && gc.getTank(window.__vtTankId);
  if (!t) return null;
  var x=t.getX(), y=t.getY(), dx=x-tx, dy=y-ty;
  return { x:x, y:y, rot:t.getRotation(), d: Math.sqrt(dx*dx+dy*dy) };
};
// ★ 回合就绪检测：回合有时间限制，结束后 setInputState 会被整段丢弃
//   (setInputState 第一行 if (!this.model.getStarted() || !this.model.getMaze()) return;)
window.__vtReady = function () {
  // RoundModel 才有 getStarted/getMaze；gc.model 是 GameModel，旧写法永远 return true。
  try {
    var gc = GameManager.getGameController();
    if (!gc) return false;
    if (!gc.getTank(window.__vtTankId)) return false;   // 回合结束时 endRound 会清空 tanks
    var rm = gc.roundController && gc.roundController.model;
    if (!rm) return false;
    if (typeof rm.getStarted === 'function' && !rm.getStarted()) return false;
    if (typeof rm.getMaze === 'function' && !rm.getMaze()) return false;
    if (window.GameModel && GameModel._STATES && gc.model && gc.model.getState) {
      if (gc.model.getState() !== GameModel._STATES.IN_ROUND) return false;
    }
    return true;
  } catch (e) { return false; }
};
window.__vtSetPose = function (x, y, r) {
  var gc = GameManager.getGameController();
  gc.setTankState(TankState.withState(window.__vtTankId, x, y, false,false, r, false,false,false,false), false);
  return 1;
};

// ---------- 一批（旧：页面内紧循环，保留但默认不用）----------
window.__vtBatch = function (wArr, nEp, steps, seg, temp, cand, minSep, noTele) {
  window.__vtNoTeleport = !!noTele;
  var w = new Float32Array(wArr);
  var net = window.__vtNet(w);
  var out = [];
  for (var e = 0; e < nEp; e++) {
    var A = cand[(Math.random() * cand.length) | 0];
    var B = cand[(Math.random() * cand.length) | 0];
    var sep = Math.sqrt((A.x - B.x) * (A.x - B.x) + (A.y - B.y) * (A.y - B.y));
    if (sep < minSep) { e--; continue; }
    // 等回合就绪：60s 回合结束后 game 会进入 BETWEEN_ROUNDS(8s)+COUNTING_DOWN(2s)，
    // 期间 setTankState/setInputState 都会被丢弃。这里同步推进虚拟帧等到新回合开始。
    var ready = false;
    for (var w8 = 0; w8 < 1800; w8++) {
      if (window.__vtReady && window.__vtReady()) { ready = true; break; }
      window.__vtStep(4);
    }
    if (!ready) { e--; continue; }
    var A2 = { x: A.x, y: A.y, rot: Math.random() * 6.283 };
    var r = window.__vtEpisode(net, A2, B, steps, seg, temp);
    if (r) out.push(r);
  }
  return out;
};

// ★ 杀掉渲染：无头模式下 SwiftShader 软件光栅化是纯浪费
window.__vtKillRender = function () {
  try {
    var g = GameManager.getGame();
    if (g && g.renderer) { g.renderer.render = function () {}; g.renderer.postRender = function () {}; return 'ok'; }
  } catch (e) { return 'ERR ' + e; }
  return 'no renderer';
};
`;

(async () => {
  const PAGES = arg('pages', 4);
  const EP_PER_PAGE = arg('episodes', 40);
  const STEPS = arg('steps', 24);
  const SEG = arg('seg', 13);
  const TEMP = (() => { const i = process.argv.indexOf('--temp'); return i < 0 ? 1.0 : Number(process.argv[i + 1]); })();
  const WFILE = argS('weights', '');
  const OUT = argS('out', path.join(__dirname, 'rollout.jsonl'));
  const KILL_RENDER = !process.argv.includes('--keep-render');

  const t0 = Date.now();
  const T = () => ((Date.now() - t0) / 1000).toFixed(1) + 's';

  // 权重：文件给了就读，否则随机初始化（并写回去，让 Python 知道初始尺寸）
  const WPARAMS = 12 * 64 + 64 + 64 * 64 + 64 + 64 * 9 + 9 + 64 + 1;
  let w;
  if (WFILE && fs.existsSync(WFILE)) {
    const j = JSON.parse(fs.readFileSync(WFILE, 'utf8'));
    w = Float32Array.from(j.w);
    if (w.length !== WPARAMS) throw new Error(`权重长度 ${w.length} != ${WPARAMS}`);
  } else {
    w = new Float32Array(WPARAMS);
    for (let i = 0; i < w.length; i++) w[i] = (Math.random() * 2 - 1) * Math.sqrt(2 / 64);
    if (WFILE) fs.writeFileSync(WFILE, JSON.stringify({ w: Array.from(w) }));
  }

  // ---- 一个浏览器 + N 个 page（比 N 个浏览器省得多）----
  const srv = await startPyServer({});
  const browser = await launch({});
  console.log(`[${T()}] 服务器+浏览器就绪`);

  const pages = [];
  for (let i = 0; i < PAGES; i++) {
    const { targetId, sessionId } = await browser.newPage('about:blank');
    await browser.send('Page.enable', {}, sessionId);
    await browser.send('Runtime.enable', {}, sessionId);
    await browser.send('Page.addScriptToEvaluateOnNewDocument', {
      source: fs.readFileSync(path.join(__dirname, 'clock.js'), 'utf8'),
    }, sessionId);
    // ★ 不在这里导航 —— 4 个页面同时加载资产会互相挤爆（实测 page0 卡在 Boot）。
    //   导航挪到下面的顺序初始化里，一次只加载一个页面。
    pages.push({ i, targetId, sessionId, browser });
  }
  console.log(`[${T()}] ${PAGES} 个页面加载完成`);

  // ---- 并行初始化 ----
  // ★ 顺序初始化：4 页同时加载会互相抢资源，资产阶段必挂。初始化是一次性的，并行只对 rollout 有意义。
  for (const p of pages) {
    const ev = (e, o) => browser.evaluate(e, p.sessionId, o);
    const loaded = browser.waitFor('Page.loadEventFired', 120000, p.sessionId);
    await browser.send('Page.navigate', { url: `${srv.origin}/index.html` }, p.sessionId);
    await loaded;
    await ev(PAGE_CODE);
    // 推进到 Menu（资产加载要交错让出真实时间）
    // 资产加载阶段：I/O 是真实时间。多页并行时资源更紧，必须给足真实时间。
    let cur = '';
    for (let k = 0; k < 3000; k++) {
      await ev('window.__vtStep(2)');
      await sleep(10);
      if (k % 4 === 0) {
        cur = await ev("(()=>{try{return GameManager.getGame().state.current}catch(e){return '?'}})()");
        if (cur === 'Menu') break;
      }
    }
    if (cur !== 'Menu') throw new Error(`page${p.i} 卡在 "${cur}"`);
    const boot = await ev(`(() => {
      var ph = GameManager.getGame();
      Constants.setMode(Constants.MODE_CLIENT_LOCAL);
      var ttGame = GameController.create(BootCampGameMode.create(), false,false,false,
        Constants.CLIENT.MAX_PLAYERS,
        Constants.GAME_MODE_INFO[Constants.GAME_MODES.BOOT_CAMP].DEFAULT_AVAILABLE_CRATES,
        false, Constants.MAZE_THEMES.STANDARD);
      // ★ 阶段 1′ 不需要 Vantage 的树 —— 它的 496 节点物理 rollout 每帧都在烧 CPU。
      //   用第二个傀儡凑够 2 个玩家让回合能开即可。
      ttGame.addPlayer('tank_a');
      ttGame.addPlayer('tank_b');
      GameManager.setGameController(ttGame);
      ph.state.start('Game', true, false, ttGame);
      return { ok: true, gameId: ttGame.getId() }; })()`);
    // 推进到 Game
    for (let k = 0; k < 200; k++) { await ev('window.__vtStep(1)'); await sleep(3);
      const s = await ev("(()=>{try{return GameManager.getGame().state.current}catch(e){return '?'}})()");
      if (s === 'Game' && k > 20) break; }
    // 装控制钩子 + 自适应等回合开始
    await ev(`window.__vtInstallControl('tank_a')`);
    await ev(`window.__vtClear = function(){var c=window.__vtCtrl;c.fwd=c.back=c.left=c.right=c.fire=false;return 1;}`);
    let started = false;
    const diag = [];
    for (let k = 0; k < 60; k++) {
      const a = await ev(`(()=>{var gc=GameManager.getGameController();var t=gc&&gc.getTank('tank_a');
        return t?{x:t.getX(),y:t.getY()}:null;})()`);
      if (!a) break;
      // ★ 必须逐帧推进 + 让出真实时间（一口气 __vtStep(6) 时坦克不动）
      await ev('window.__vtCtrl.fwd=true');
      for (let z = 0; z < 8; z++) { await ev('window.__vtStep(1)'); await sleep(8); }
      await ev('window.__vtCtrl.fwd=false');
      const b = await ev(`(()=>{var gc=GameManager.getGameController();var t=gc&&gc.getTank('tank_a');
        return t?{x:t.getX(),y:t.getY()}:null;})()`);
      if (b && Math.hypot(b.x - a.x, b.y - a.y) > 0.5) { started = true; diag.push(`k=${k} moved`); break; }
      if (k % 5 === 0) diag.push(`k=${k} a=${a?a.x.toFixed(0)+','+a.y.toFixed(0):'null'} b=${b?b.x.toFixed(0)+','+b.y.toFixed(0):'null'}`);
    }
    console.log(`[${T()}] page${p.i} 预热诊断: ${diag.join(' | ')}`);
    if (!started) {
      const info = await ev(`(() => {
        var gc = GameManager.getGameController();
        var t = gc && gc.getTank('tank_a');
        return { hasGC: !!gc, hasTank: !!t,
                 players: gc ? gc.getActivePlayerIds() : null,
                 started: gc && gc.getGameState ? String(gc.getGameState()) : '?',
                 ctrl: window.__vtCtrl, tankId: window.__vtTankId,
                 hooks: (window.__vtBefore||[]).length,
                 roundState: (function(){ try { var d = (gc.getRoundState()||{}).data; return d? Object.keys(d).join(','):'?'; } catch(e){ return 'ERR'; } })() };
      })()`);
      throw new Error(`page${p.i} 回合没起来: ${JSON.stringify(info)}`);
    }
    p.render = KILL_RENDER ? await ev('window.__vtKillRender()') : 'skipped';
    p.cand = await ev(`(() => {
      var mz = GameManager.getGameController().getMaze();
      return mz.reachable.map(function(r){ return {x: r.x*${TILE}+${TILE / 2}, y: r.y*${TILE}+${TILE / 2}}; }); })()`);
    p.ready = true;
    console.log(`[${T()}] page${p.i} 就绪  render=${p.render}  格位=${p.cand.length}`);
  }
  console.log(`[${T()}] 全部页面就绪  render=${pages.map((p) => p.render).join(',')}  可达格位=${pages.map((p) => p.cand.length).join(',')}`);

  // ---- 并行跑批次（每个 page 一次 CDP 往返跑 EP_PER_PAGE 局）----
  const tRun = Date.now();
  // ★ clock.js 已接管 new Date()（游戏 update 用的是 `var time=new Date()`），
  //   物理 dt 现在是精确的虚拟 16.667ms/帧 —— 同步紧循环即可，无需让出真实时间。
  const results = await Promise.all(pages.map(async (p) => {
    const wArr = Array.from(w);
    return browser.evaluate(
      `window.__vtBatch(${JSON.stringify(wArr)}, ${EP_PER_PAGE}, ${STEPS}, ${SEG}, ${TEMP}, ${JSON.stringify(p.cand)}, 25, false)`,
      p.sessionId, { awaitPromise: true, returnByValue: true });
  }));
  const runMs = Date.now() - tRun;

  // ---- 汇总写盘 ----
  const ws = fs.createWriteStream(OUT);
  let nEp = 0, nStep = 0, sumR = 0, sumMaze = 1e9, mazeN = 0, sumMove = 0, sumPath = 0, nDead = 0;
  for (const batch of results) {
    for (const ep of (batch || [])) {
      nEp++; sumMaze = Math.min(sumMaze, ep.finalMaze); sumMove += (ep.moved||0);
      sumPath += (ep.path || 0); if (ep.dead) nDead++;
      for (const tr of ep.traj) { nStep++; sumR += tr.r; }
      ws.write(JSON.stringify(ep) + '\n');
    }
  }
  ws.end();
  await new Promise((r) => ws.on('finish', r));

  const stepPerSec = nStep / (runMs / 1000);
  console.log(`\n===== Rollout =====`);
  console.log(`  页面 ${PAGES}  每页 ${EP_PER_PAGE} 局  实际 ${nEp} 局  ${nStep} 步`);
  console.log(`  跑步耗时 ${(runMs / 1000).toFixed(1)}s   →  ${stepPerSec.toFixed(1)} 步/秒  (${(nEp / (runMs / 1000)).toFixed(1)} 局/秒)`);
  console.log(`  平均每步奖励 ${(sumR / Math.max(nStep, 1)).toFixed(4)}`);
  console.log(`  最优最终迷宫距离 ${sumMaze === 1e9 ? '-' : sumMaze}`);
  // ★ moved 是「净位移」（起点→终点），随机初始策略来回走会被抵消成几像素；
  //   真正反映坦克有没有动的是 path（逐步位移累加）与每步位移。
  const avgPath = sumPath / Math.max(nEp, 1);
  const avgStep = sumPath / Math.max(nStep, 1) * 10; // 单位→像素
  console.log(`  平均每局净位移 ${(sumMove/Math.max(nEp,1)).toFixed(2)} 像素`);
  console.log(`  平均每步位移 ${avgStep.toFixed(2)} 像素 (每步 ${SEG} 帧, 满速上限 ${(15.95*SEG/60*10).toFixed(1)} 像素)`);
  console.log(`  平均每局路径长度 ${avgPath.toFixed(1)} 单位 = ${(avgPath*10).toFixed(1)} 像素   死亡局 ${nDead}`);
  console.log(`  输出 ${OUT}  ${(fs.statSync(OUT).size / 1048576).toFixed(2)} MB`);
  console.log(`  总用时 ${T()}`);
  console.log(`RESULT ${JSON.stringify({ pages: PAGES, episodes: nEp, steps: nStep, runMs, stepPerSec: +stepPerSec.toFixed(1), avgReward: +(sumR / Math.max(nStep, 1)).toFixed(4), avgPath: +avgPath.toFixed(2), avgStepPx: +avgStep.toFixed(2), avgNetMoved: +(sumMove/Math.max(nEp,1)).toFixed(2) })}`);

  await browser.close();
  await srv.close();
})().catch((e) => { console.error('WORKER FAILED:', (e && e.stack) || e); process.exit(1); });
