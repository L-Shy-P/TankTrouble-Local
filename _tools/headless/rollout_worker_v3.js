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
    w1: take(82 * 128), b1: take(128),
    w2: take(128 * 128), b2: take(128),
    w3: take(128 * 9), b3: take(9),
    w4: take(128 * 1), b4: take(1),
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
  var h1 = new Float32Array(128), h2 = new Float32Array(128);
  var lg = new Float32Array(9), vv = new Float32Array(1);
  linear(obs, net.w1, net.b1, 82, 128, h1);
  for (var i = 0; i < 128; i++) if (h1[i] < 0) h1[i] = 0;
  linear(h1, net.w2, net.b2, 128, 128, h2);
  for (var j = 0; j < 128; j++) if (h2[j] < 0) h2[j] = 0;
  linear(h2, net.w3, net.b3, 128, 9, lg);
  linear(h2, net.w4, net.b4, 128, 1, vv);
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

// ---------- 观测（v3：全地图）----------
window.__vtMapW = 16; window.__vtMapH = 10;

// 全地图：一次性构建（一局内不变），160 维
window.__vtBuildMap = function () {
  var mz = GameManager.getGameController().getMaze();
  var g = new Float32Array(60);
  for (var y = 0; y < 6; y++) {
    for (var x = 0; x < 10; x++) {
      if (x >= mz.width || y >= mz.height) { g[y * 10 + x] = -1; continue; }   // ★ 界外=-1
      var inside = false;
      try { inside = !!mz.isPositionInsideMaze({ x: x, y: y }); } catch (e) { inside = false; }
      g[y * 10 + x] = inside ? 0 : 1;      // 0=空, 1=墙
    }
  }
  window.__vtMapCache = g;
  window.__vtMapWReal = mz.width;
  window.__vtMapHReal = mz.height;
  return g;
};

window.__vtObs = function (ax, ay, rot, bx, by, trot, md, neigh, wp) {
  var o = new Float32Array(82);
  o[0] = ax / 100; o[1] = ay / 100;
  o[2] = Math.sin(rot); o[3] = Math.cos(rot);
  o[4] = bx / 100; o[5] = by / 100;
  o[6] = Math.sin(trot || 0); o[7] = Math.cos(trot || 0);
  // ★ 迷宫实际尺寸 —— 让网络知道哪部分是真的、哪部分是填充
  o[8] = (window.__vtMapWReal || 10) / 10;
  o[9] = (window.__vtMapHReal || 6) / 6;
  // ★ 全地图 16×10（-1=界外, 0=空, 1=墙）
  var g = window.__vtMapCache;
  if (g) { for (var i = 0; i < 60; i++) o[10 + i] = g[i]; }
  // 距离场脚手架（阶段 C 传 null 则全 0）
  // ★ 脚手架：到「下一个路径点」的相对方位（阶段 C 起传 null 自动置 0）
  if (wp) {
    var wdx = wp.x - ax, wdy = wp.y - ay;
    var wdist = Math.sqrt(wdx*wdx + wdy*wdy);
    var wbear = Math.atan2(wdy, wdx) - rot;
    while (wbear > Math.PI) wbear -= 2*Math.PI;
    while (wbear < -Math.PI) wbear += 2*Math.PI;
    o[70] = Math.sin(wbear); o[71] = Math.cos(wbear); o[72] = wdist / 20;
  }
  var base = 10 + 60 + 3;
  if (md !== null && md !== undefined) {
    o[base] = md / 10;
    if (neigh) { for (var k = 0; k < 8; k++) o[base + 1 + k] = neigh[k]; }
  }
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

// ---------- 一局（v2：距离场 + 位姿相似度 + 相交静止终止）----------
window.__vtEpisode = function (net, A, B, steps, seg, temp, CFG) {
  CFG = CFG || {};
  var W_FIELD = CFG.W_FIELD !== undefined ? CFG.W_FIELD : 0.5;
  var P_FIELD = CFG.P_FIELD !== undefined ? CFG.P_FIELD : 0.7;
  var W_POSE  = CFG.W_POSE  !== undefined ? CFG.W_POSE  : 0.0;
  var SP = CFG.SP || 6.0, SA = CFG.SA || 0.45, SIM_MIN = CFG.SIM_MIN || 0.35;
  var TIME_BONUS = CFG.TIME_BONUS || 0.0;
  var W_DENSE = CFG.W_DENSE || 0.0;
  var REACH_R = CFG.REACH_R || 2.5;
  var STILL_EPS = CFG.STILL_EPS || 0.3, STILL_NEED = CFG.STILL_NEED || 30;

  var gc = GameManager.getGameController();
  var id = window.__vtTankId;
  var mz = gc.getMaze();

  gc.setTankState(TankState.withState(id, A.x, A.y, false, false, A.rot, false, false, false, false), false);
  for (var z0 = 0; z0 < 3; z0++) window.__vtStep(1);
  var t = gc.getTank(id);
  if (!t) return null;
  var ax0 = t.getX(), ay0 = t.getY();
  var ax = ax0, ay = ay0, rot = t.getRotation();
  window.__vtBuildMap();
  var traj = [], pathLen = 0, stillFrames = 0, reached = false;
  var bRot = B.rot || 0;
  var USE_DF = (CFG.USE_DF === undefined) ? true : !!CFG.USE_DF;   // 阶段C起关掉脚手架

  function tileOf(v) { return Math.floor(v / 10); }
  function mdAt(tx, ty) {
    try {
      var d = mz.getDistanceBetweenPositions({x: tx, y: ty},
                                             {x: tileOf(B.x), y: tileOf(B.y)});
      return (d === false || d === null || d === undefined) ? 99 : d;
    } catch (e) { return 99; }
  }
  function mdOf(x, y) { return mdAt(tileOf(x), tileOf(y)); }
  // ★ 8 邻居距离场（缓存：同一格内不变，只在换格时重算 8 次）
  var _cTile = -9999, _cN = null, _cMd = -1, _cWp = null;
  function dfAt(x, y) {
    var tx = tileOf(x), ty = tileOf(y), key = ty * 1000 + tx;
    if (key !== _cTile) {
      _cTile = key; _cMd = mdAt(tx, ty);
      var NB = [[0,-1],[1,-1],[1,0],[1,1],[0,1],[-1,1],[-1,0],[-1,-1]];
      _cN = new Float32Array(8);
      var bi = -1, bv = 1e9;
      for (var k = 0; k < 8; k++) {
        var v = mdAt(tx + NB[k][0], ty + NB[k][1]);
        _cN[k] = Math.max(-1, Math.min(1, (v - _cMd) / 5));
        if (v < bv) { bv = v; bi = k; }          // 下坡邻居 = 路径上的下一格
      }
      if (bi >= 0 && bv < _cMd) {
        // 下一格格心：稠密塑形目标。永远在可达路径上，绝不指进墙里。
        _cWp = { x: (tx + NB[bi][0]) * 10 + 5, y: (ty + NB[bi][1]) * 10 + 5 };
      } else {
        _cWp = { x: B.x, y: B.y };               // 已在目标格：直接用目标
      }
    }
    return { md: _cMd, neigh: _cN, wp: _cWp };
  }
  function wrapPi(a) { while (a > Math.PI) a -= 2*Math.PI; while (a < -Math.PI) a += 2*Math.PI; return a; }
  function simOf(x, y, r) {
    var dp = Math.sqrt((x-B.x)*(x-B.x) + (y-B.y)*(y-B.y));
    var da = Math.abs(wrapPi(bRot - r));
    // ★ 拉普拉斯核（不是高斯）：在 0 附近梯度非零，完美更值钱
    return { sim: Math.exp(-dp/SP - da/SA), dp: dp, da: da };
  }
  function gateOf(md) { return md <= 0 ? 1.0 : (md === 1 ? 0.5 : (md === 2 ? 0.2 : 0.05)); }

  var mdPrev = mdOf(ax, ay);
  var ps0 = simOf(ax, ay, rot);
  var simGPrev = ps0.sim * gateOf(mdPrev);
  var dwPrev = null;
  var prevX = ax, prevY = ay;
  var alive = true;
  var s = 0;

  for (s = 0; s < steps; s++) {
    var df = USE_DF ? dfAt(ax, ay) : null;
    var obs = window.__vtObs(ax, ay, rot, B.x, B.y, bRot,
                             df ? df.md : null, df ? df.neigh : null,
                             (USE_DF && df) ? df.wp : null);
    var f = window.__vtFwd(net, obs);
    var smp = window.__vtSample(f.logits, temp);
    window.__vtAct(smp.a);
    for (var zf = 0; zf < seg; zf++) window.__vtStep(1);

    var t2 = gc.getTank(id);
    if (!t2) { traj.push({obs: Array.from(obs), a: smp.a, logp: smp.logp, v: f.value, r: -5, done: 1}); alive = false; break; }
    ax = t2.getX(); ay = t2.getY(); rot = t2.getRotation();
    var movedNow = Math.sqrt((ax-prevX)*(ax-prevX) + (ay-prevY)*(ay-prevY));
    pathLen += movedNow; prevX = ax; prevY = ay;
    if (movedNow < STILL_EPS) stillFrames += seg; else stillFrames = 0;   // 单次连续

    var md = mdOf(ax, ay);
    var ps = simOf(ax, ay, rot);
    var simG = ps.sim * gateOf(md);
    // 稠密塑形：朝「距离场下坡方向的下一格格心」移动（绕墙正确，绝非欧氏）
    var df2 = USE_DF ? dfAt(ax, ay) : null;
    var wp2 = df2 ? df2.wp : { x: B.x, y: B.y };
    var dw = Math.sqrt((ax-wp2.x)*(ax-wp2.x) + (ay-wp2.y)*(ay-wp2.y));
    var rDense = (dwPrev === null) ? 0 : (W_DENSE * (dwPrev - dw) / 10);
    dwPrev = dw;

    // ================= 奖励（注意：没有任何时间项）=================
    // 1) 距离场：亚线性幂 → 最后一格最值钱
    var r = rDense;
    r += W_FIELD * (Math.pow(mdPrev, P_FIELD) - Math.pow(md, P_FIELD));
    // 2) 位姿相似度（门控后）
    r += W_POSE * (simG - simGPrev);
    mdPrev = md; simGPrev = simG;

    // ================= 终局：相交 + 连续静止 =================
    var done = 0;
    if (ps.dp <= REACH_R && stillFrames >= STILL_NEED) {
      var speed = 1 - Math.min(1, s / Math.max(1, steps));
      var base = (ps.sim < SIM_MIN) ? 1.0 : (2.0 + 8.0 * ps.sim);   // 分级：完美≈10，勉强≈1
      r += base * (1 + TIME_BONUS * speed);
      done = 1; reached = true;
    }
    traj.push({obs: Array.from(obs), a: smp.a, logp: smp.logp, v: f.value, r: r, done: done});
    if (done) break;
  }
  window.__vtCtrl.fwd = window.__vtCtrl.back = window.__vtCtrl.left = window.__vtCtrl.right = false;

  var psEnd = simOf(ax, ay, rot);
  var mv = Math.sqrt((ax-ax0)*(ax-ax0)+(ay-ay0)*(ay-ay0));
  return { traj: traj, moved: mv, path: pathLen, steps: traj.length,
           ax0: ax0, ay0: ay0,
           finalSim: psEnd.sim, finalPosErr: psEnd.dp, finalAngErr: psEnd.da,
           finalMaze: mdOf(ax, ay), reached: reached, usedSteps: traj.length,
           timedOut: (!reached && alive), ax: ax, ay: ay, dead: !alive };
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
window.__vtBatch = function (wArr, nEp, steps, seg, temp, cand, minSep, noTele, CFG) {
  window.__vtNoTeleport = !!noTele;
  var w = new Float32Array(wArr);
  var net = window.__vtNet(w);
  var out = [];
  for (var e = 0; e < nEp; e++) {
    var A = cand[(Math.random() * cand.length) | 0];
    var B = cand[(Math.random() * cand.length) | 0];
    B = { x: B.x, y: B.y, rot: Math.random() * 6.283 };
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
    var r = window.__vtEpisode(net, A2, B, steps, seg, temp, CFG);
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
  const WPARAMS = 82 * 128 + 128 + 128 * 128 + 128 + 128 * 9 + 9 + 128 + 1;
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
  const CFG = process.argv.includes("--cfg") ? JSON.parse(process.argv[process.argv.indexOf("--cfg")+1]) : {};
  const tRun = Date.now();
  // ★ clock.js 已接管 new Date()（游戏 update 用的是 `var time=new Date()`），
  //   物理 dt 现在是精确的虚拟 16.667ms/帧 —— 同步紧循环即可，无需让出真实时间。
  const results = await Promise.all(pages.map(async (p) => {
    const wArr = Array.from(w);
    return browser.evaluate(
      `window.__vtBatch(${JSON.stringify(wArr)}, ${EP_PER_PAGE}, ${STEPS}, ${SEG}, ${TEMP}, ${JSON.stringify(p.cand)}, 25, false, ${JSON.stringify(CFG)})`,
      p.sessionId, { awaitPromise: true, returnByValue: true });
  }));
  const runMs = Date.now() - tRun;

  // ---- 汇总写盘 ----
  const ws = fs.createWriteStream(OUT);
  let nEp = 0, nStep = 0, sumR = 0, sumMaze = 1e9, mazeN = 0, sumMove = 0, sumPath = 0, nDead = 0;
  let sumSim = 0, nReach = 0, nPerfect = 0, nTimeout = 0;
  for (const batch of results) {
    for (const ep of (batch || [])) {
      nEp++; sumMaze = Math.min(sumMaze, ep.finalMaze); sumMove += (ep.moved||0);
      sumSim += (ep.finalSim||0); if (ep.reached) nReach++;
      if ((ep.finalSim||0) >= 0.9) nPerfect++;
      if (ep.timedOut) nTimeout++;
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
  console.log(`  avgFinalSim ${(sumSim/Math.max(nEp,1)).toFixed(3)}  reachRate ${(nReach/Math.max(nEp,1)).toFixed(3)}  perfectRate ${(nPerfect/Math.max(nEp,1)).toFixed(3)}  timeoutRate ${(nTimeout/Math.max(nEp,1)).toFixed(3)}`);
  console.log(`  平均每局路径长度 ${avgPath.toFixed(1)} 单位 = ${(avgPath*10).toFixed(1)} 像素   死亡局 ${nDead}`);
  console.log(`  输出 ${OUT}  ${(fs.statSync(OUT).size / 1048576).toFixed(2)} MB`);
  console.log(`  总用时 ${T()}`);
  console.log(`RESULT ${JSON.stringify({ pages: PAGES, episodes: nEp, steps: nStep, runMs, stepPerSec: +stepPerSec.toFixed(1), avgReward: +(sumR / Math.max(nStep, 1)).toFixed(4), avgPath: +avgPath.toFixed(2), avgStepPx: +avgStep.toFixed(2), avgNetMoved: +(sumMove/Math.max(nEp,1)).toFixed(2) })}`);

  await browser.close();
  await srv.close();
})().catch((e) => { console.error('WORKER FAILED:', (e && e.stack) || e); process.exit(1); });
