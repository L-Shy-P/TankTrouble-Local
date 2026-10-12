# -*- coding: utf-8 -*-
"""
生成 rollout_worker_v2.js —— 阶段1′ 奖励重设计版
=================================================
变更（见 docs/Vantage躲弹实现/阶段1p-奖励重设计-2026-10-07.md）：
  1. 观测 12 → 14（加目标朝向 sin/cos）——任务要"贴合位姿"，必须知道目标角度
  2. 奖励 = 非线性距离场(md^0.7) + 位姿相似度(拉普拉斯核 × 距离场门控)
  3. 时间：**不是每步惩罚**，只作 MAX_STEPS 终止参数 + 终局速度加成
  4. 终局：相交 + 连续静止 0.5s → 分级奖励(位姿越好给越多)
"""
import io, sys
sys.stdout.reconfigure(encoding='utf-8')

src = '_tools/headless/rollout_worker.js'
dst = '_tools/headless/rollout_worker_v2.js'
s = io.open(src, encoding='utf-8').read()
done = []

# ---------- 1) __vtNet: 输入 12 → 14 ----------
s = s.replace("w1: take(12 * 64)", "w1: take(14 * 64)", 1); done.append('net')
# ---------- 2) __vtFwd: 12 → 14 ----------
s = s.replace("linear(obs, net.w1, net.b1, 12, 64, h1)", "linear(obs, net.w1, net.b1, 14, 64, h1)", 1)
# ---------- 3) __vtObs: 加目标朝向 ----------
s = s.replace("window.__vtObs = function (ax, ay, rot, bx, by) {",
              "window.__vtObs = function (ax, ay, rot, bx, by, trot) {", 1)
s = s.replace("  var o = new Float32Array(12);", "  var o = new Float32Array(14);", 1)
s = s.replace("  o[11] = fwdDot;\n  return o;",
              "  o[11] = fwdDot;\n  // ★ 目标朝向：任务是贴合【位姿】，必须知道目标角度\n"
              "  o[12] = Math.sin(trot || 0); o[13] = Math.cos(trot || 0);\n  return o;", 1)
done.append('obs')
# ---------- 4) WPARAMS: 12 → 14 ----------
s = s.replace("const WPARAMS = 12 * 64 + 64", "const WPARAMS = 14 * 64 + 64", 1)
done.append('wparams')

# ---------- 5) __vtEpisode 整体替换 ----------
i = s.find("// ---------- 一局 ----------")
j = s.find("// ---------- 单段：设控制")
assert i > 0 and j > i, 'episode anchor'
NEW_EP = r'''// ---------- 一局（v2：距离场 + 位姿相似度 + 相交静止终止）----------
window.__vtEpisode = function (net, A, B, steps, seg, temp, CFG) {
  CFG = CFG || {};
  var W_FIELD = CFG.W_FIELD !== undefined ? CFG.W_FIELD : 0.5;
  var P_FIELD = CFG.P_FIELD !== undefined ? CFG.P_FIELD : 0.7;
  var W_POSE  = CFG.W_POSE  !== undefined ? CFG.W_POSE  : 0.0;
  var SP = CFG.SP || 6.0, SA = CFG.SA || 0.45, SIM_MIN = CFG.SIM_MIN || 0.35;
  var TIME_BONUS = CFG.TIME_BONUS || 0.0;
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
  var traj = [], pathLen = 0, stillFrames = 0, reached = false;
  var bRot = B.rot || 0;

  function tileOf(v) { return Math.floor(v / 10); }
  function mdOf(x, y) {
    try {
      var d = mz.getDistanceBetweenPositions({x: tileOf(x), y: tileOf(y)},
                                             {x: tileOf(B.x), y: tileOf(B.y)});
      return (d === false || d === null || d === undefined) ? 99 : d;
    } catch (e) { return 99; }
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
  var prevX = ax, prevY = ay;
  var alive = true;
  var s = 0;

  for (s = 0; s < steps; s++) {
    var obs = window.__vtObs(ax, ay, rot, B.x, B.y, bRot);
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

    // ================= 奖励（注意：没有任何时间项）=================
    // 1) 距离场：亚线性幂 → 最后一格最值钱
    var r = W_FIELD * (Math.pow(mdPrev, P_FIELD) - Math.pow(md, P_FIELD));
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

'''
s = s[:i] + NEW_EP + s[j:]
done.append('episode')

# ---------- 6) __vtBatch：目标带朝向 + 传 CFG ----------
s = s.replace("window.__vtBatch = function (wArr, nEp, steps, seg, temp, cand, minSep, noTele) {",
              "window.__vtBatch = function (wArr, nEp, steps, seg, temp, cand, minSep, noTele, CFG) {", 1)
s = s.replace("var B = cand[(Math.random() * cand.length) | 0];",
              "var B = cand[(Math.random() * cand.length) | 0];\n    B = { x: B.x, y: B.y, rot: Math.random() * 6.283 };", 1)
s = s.replace("var r = window.__vtEpisode(net, A2, B, steps, seg, temp);",
              "var r = window.__vtEpisode(net, A2, B, steps, seg, temp, CFG);", 1)
done.append('batch')

# ---------- 7) Node 侧：RESULT 加新指标 ----------
s = s.replace("sumMaze = Math.min(sumMaze, ep.finalMaze); sumMove += (ep.moved||0);",
              "sumMaze = Math.min(sumMaze, ep.finalMaze); sumMove += (ep.moved||0);\n"
              "      sumSim += (ep.finalSim||0); if (ep.reached) nReach++;\n"
              "      if ((ep.finalSim||0) >= 0.9) nPerfect++;\n"
              "      if (ep.timedOut) nTimeout++;", 1)
s = s.replace("let nEp = 0, nStep = 0, sumR = 0, sumMaze = 1e9, mazeN = 0, sumMove = 0;",
              "let nEp = 0, nStep = 0, sumR = 0, sumMaze = 1e9, mazeN = 0, sumMove = 0;\n"
              "  let sumSim = 0, nReach = 0, nPerfect = 0, nTimeout = 0;", 1)
s = s.replace("""console.log(`  平均每局路径长度""",
              """console.log(`  avgFinalSim ${(sumSim/Math.max(nEp,1)).toFixed(3)}  reachRate ${(nReach/Math.max(nEp,1)).toFixed(3)}  perfectRate ${(nPerfect/Math.max(nEp,1)).toFixed(3)}  timeoutRate ${(nTimeout/Math.max(nEp,1)).toFixed(3)}`);
  console.log(`  平均每局路径长度""", 1)
s = s.replace("""avgNetMoved: +((sumMove/Math.max(nEp,1)).toFixed(2)) }`);""",
              """avgNetMoved: +((sumMove/Math.max(nEp,1)).toFixed(2)),
    avgFinalSim: +(sumSim/Math.max(nEp,1)).toFixed(4), reachRate: +(nReach/Math.max(nEp,1)).toFixed(4),
    perfectRate: +(nPerfect/Math.max(nEp,1)).toFixed(4), timeoutRate: +(nTimeout/Math.max(nEp,1)).toFixed(4) }`);""", 1)
s = s.replace("window.__vtBatch(${JSON.stringify(wArr)}, ${EP_PER_PAGE}, ${STEPS}, ${SEG}, ${TEMP}, ${JSON.stringify(p.cand)}, 25, false)",
              "window.__vtBatch(${JSON.stringify(wArr)}, ${EP_PER_PAGE}, ${STEPS}, ${SEG}, ${TEMP}, ${JSON.stringify(p.cand)}, 25, false, ${JSON.stringify(CFG)})", 1)
s = s.replace("  const FRAME_MS = Number(",
              "  const CFG = process.argv.includes('--cfg') ? JSON.parse(process.argv[process.argv.indexOf('--cfg') + 1]) : {};\n  const FRAME_MS = Number(", 1)
done.append('node-side')

io.open(dst, 'w', encoding='utf-8').write(s)
print('生成', dst, '| 变更:', done, '| 字节', len(s))
