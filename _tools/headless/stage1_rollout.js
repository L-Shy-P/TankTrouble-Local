'use strict';
/* 阶段 1′ 移动任务 —— episode 采集器
 *
 * 任务：随机给起始位姿 + 目标位姿，智能体输出 9 个操作之一，尽可能短时间贴合。
 * 奖励：势能塑形 r_t = d(s_{t-1}) - d(s_t)  （靠近得正分，远离得负分）
 *
 * 关键：策略跑在 Node/Python 侧，靠 CDP 驱动浏览器 —— 训练时不需要在 JS 里实现网络。
 *
 *   node _tools/headless/stage1_rollout.js --episodes 200 --seg 13 --out data.jsonl
 */
const fs = require('fs');
const path = require('path');
const { Match } = require('./match');

const TILE = 10;
const OPS = [
  null,
  { n: '前',   fwd: 1 }, { n: '后', back: 1 }, { n: '左', left: 1 }, { n: '右', right: 1 },
  { n: '前左', fwd: 1, left: 1 }, { n: '前右', fwd: 1, right: 1 },
  { n: '后左', back: 1, left: 1 }, { n: '后右', back: 1, right: 1 },
];

function arg(n, d) { const i = process.argv.indexOf('--' + n); return i < 0 ? d : Number(process.argv[i + 1]); }

(async () => {
  const EPISODES = arg('episodes', 200);
  const SEG = arg('seg', 13);
  const STEPS = arg('steps', 6);
  const OUT = process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1]
    : path.join(__dirname, 'stage1_random.jsonl');

  const t0 = Date.now();
  const T = () => ((Date.now() - t0) / 1000).toFixed(1) + 's';
  const m = new Match();
  const stream = fs.createWriteStream(OUT);

  try {
    await m.open({ humanIds: ['tank_a'], aiCount: 0, vantCount: 1 });
    console.log(`[${T()}] 开局 ${JSON.stringify(m.bootstrap)}`);

    // 自适应等回合开始（倒计时期间输入被丢弃）
    await m.clearControl();
    let started = false;
    for (let i = 0; i < 30; i++) {
      const a = await m.myTank(); if (!a) break;
      await m.setControl({ fwd: true }); await m.pump(8, { yieldMs: 4 });
      const b = await m.myTank();
      if (b && Math.hypot(b.x - a.x, b.y - a.y) > 0.5) { started = true; break; }
    }
    await m.clearControl();
    if (!started) throw new Error('回合没起来');
    console.log(`[${T()}] 回合已开始`);

    const mz = await m.maze();
    const cand = mz.reachable.map((r) => ({ x: r.x * TILE + TILE / 2, y: r.y * TILE + TILE / 2 }));
    console.log(`[${T()}] 迷宫 ${mz.width}x${mz.height} 可达 ${cand.length} 格`);

    // ★ 两种距离：
    //   __vtD  = 欧氏距离(像素) —— 奖励用它，因为【连续】；
    //   __vtMD = 迷宫图距离(瓦片跳数) —— 任务指标用它，但它是【整数】，
    //            实测每段只走 ~0.5 格 → d-d2 恒为 0 → 奖励全零，不能当奖励。
    await m.eval(`window.__vtD = function (ax, ay, bx, by) {
      var dx = ax - bx, dy = ay - by;
      return Math.sqrt(dx * dx + dy * dy) / ${TILE}; }`);
    await m.eval(`window.__vtMD = function (ax, ay, bx, by) {
      var mz = GameManager.getGameController().getMaze();
      var d = mz.getDistanceBetweenPositions({x: Math.floor(ax/${TILE}), y: Math.floor(ay/${TILE})},
                                             {x: Math.floor(bx/${TILE}), y: Math.floor(by/${TILE})});
      return d === false ? -1 : d; }`);

    // ★ 把「设控制 + 泵帧 + 读状态 + 算距离」合并成【一次 CDP 往返】
    //   原来每步 3~4 次往返 ≈ 47ms，现在 1 次。
    await m.eval(`window.__vtStep1 = function (ctrl, frames, tx, ty) {
      var c = window.__vtCtrl;
      c.fwd = !!ctrl.fwd; c.back = !!ctrl.back; c.left = !!ctrl.left; c.right = !!ctrl.right;
      window.__vtStep(frames);
      var gc = GameManager.getGameController();
      var t = gc && gc.getTank(window.__vtTankId);
      if (!t) return null;
      var x = t.getX(), y = t.getY(), r = t.getRotation();
      var dx = x - tx, dy = y - ty;
      return { x: x, y: y, rot: r, d: Math.sqrt(dx * dx + dy * dy) / ${TILE} };
    }`);
    await m.eval(`window.__vtSet = function (x, y, rot) {
      var gc = GameManager.getGameController();
      gc.setTankState(TankState.withState(window.__vtTankId, x, y, false, false, rot, false, false, false, false), false);
      return 1; }`);
    await m.eval(`window.__vtClear = function () {
      var c = window.__vtCtrl; c.fwd = c.back = c.left = c.right = c.fire = false; return 1; }`);

    let n = 0, sumRew = 0, sumSteps = 0;
    for (let ep = 0; ep < EPISODES; ep++) {
      const A = cand[(Math.random() * cand.length) | 0];
      const B = cand[(Math.random() * cand.length) | 0];
      if (Math.hypot(A.x - B.x, A.y - B.y) < 20) continue;   // 太近的不要

      await m.eval(`window.__vtSet(${A.x}, ${A.y}, ${(Math.random() * 6.283).toFixed(4)})`);
      await m.pump(4, { yieldMs: 2 });
      let cur = await m.myTank();
      if (!cur) continue;
      let d = await m.eval(`window.__vtD(${cur.x}, ${cur.y}, ${B.x}, ${B.y})`);
      if (d < 0) continue;

      const epId = ep;
      for (let t = 0; t < STEPS; t++) {
        // ---- 观测（这里策略是随机的，但格式按训练需要给全）----
        const obs = {
          tank: [cur.x, cur.y, cur.rot],
          target: [B.x, B.y],
          rel: [(B.x - cur.x) / 100, (B.y - cur.y) / 100],
          dist: d,
          // 我方朝向到目标的方向夹角（归一化）
          bearing: Math.atan2(B.y - cur.y, B.x - cur.x),
        };

        const a = 1 + ((Math.random() * 8) | 0);
        const o = OPS[a];
        const nxt = await m.eval(`window.__vtStep1(${JSON.stringify({ fwd: !!o.fwd, back: !!o.back, left: !!o.left, right: !!o.right })}, ${SEG}, ${B.x}, ${B.y})`);
        if (!nxt) break;
        const d2 = nxt.d;

        const reward = d - d2;                 // 势能塑形：靠近为正
        stream.write(JSON.stringify({
          ep: epId, t, obs,
          action: a, actionName: o.n,
          nextObs: { tank: [nxt.x, nxt.y, nxt.rot], rel: [(B.x - nxt.x) / 100, (B.y - nxt.y) / 100], dist: d2 },
          reward,
          done: t === STEPS - 1,
        }) + '\n');
        sumRew += reward; sumSteps++;
        cur = nxt; d = d2;
      }
      n++;
      if (n % 20 === 0) console.log(`[${T()}] ${n}/${EPISODES} 局  平均奖励 ${(sumRew / sumSteps).toFixed(3)}  样本 ${sumSteps}`);
    }
    stream.end();
    await new Promise((r) => stream.on('finish', r));
    const sz = fs.statSync(OUT).size;
    console.log(`\n===== 采集完成 =====`);
    console.log(`  局数 ${n}  样本 ${sumSteps}  平均每步奖励 ${(sumRew / Math.max(sumSteps, 1)).toFixed(4)}`);
    console.log(`  输出 ${OUT}  (${(sz / 1048576).toFixed(2)} MB)`);
    console.log(`  吞吐 ${(n / ((Date.now() - t0) / 1000)).toFixed(2)} 局/秒   ${(sumSteps / ((Date.now() - t0) / 1000)).toFixed(1)} 样本/秒`);
    console.log(`  总用时 ${T()}`);
  } catch (e) {
    console.error('FAILED:', (e && e.stack) || e);
    process.exitCode = 1;
  } finally { stream.end(); await m.close(); }
})();
