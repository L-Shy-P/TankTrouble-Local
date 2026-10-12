'use strict';
/* 阶段0 探针3：录制起点之前的随机数消费稳不稳？
 *
 * 背景：回放要逐位复现，就要求"逻辑同一时刻"的随机数消费计数一致。
 * 做法：每帧读 {游戏状态, 迷宫是否已生成, 随机数消费计数}，看
 *   delta = (IN_ROUND 时的计数) - (迷宫刚生成时的计数)
 * 在多次独立开局的抖动。抖动 = 回放风险（错位一帧就全偏）。
 *
 *   node _tools/headless/_probe_phase0_rng_offset.js [--runs 4]
 */
const { Match } = require('./match');

const S = `(() => {
  var gc = GameManager.getGameController();
  var s = window.__vtRng.state();
  return { st: gc ? gc.getState() : null, hasMaze: !!(gc && gc.getMaze()),
           rn: (s.mode === 'play') ? s.idx : s.len, t: window.__vt.t, steps: window.__vt.steps };
})()`;

(async () => {
  const runs = Number((process.argv[process.argv.indexOf('--runs') + 1]) || 4);
  for (let k = 0; k < runs; k++) {
    const m = new Match();
    try {
      // waitRound:false —— 在【倒计时里】逐帧看随机数消费是怎么走的
      await m.open({ humanIds: ['tank_a', 'tank_b'], aiCount: 0, control: false, waitRound: false });
      let mazeAt = null, roundAt = null;
      for (let f = 0; f < 600; f++) {
        const s = await m.eval(S);
        if (!mazeAt && s.hasMaze) mazeAt = { f, rn: s.rn, steps: s.steps, t: s.t };
        if (s.st === 'in round') { roundAt = { f, rn: s.rn, steps: s.steps, t: s.t }; break; }
        await m.pump(1, { yieldMs: 0 });
      }
      const maze = await m.maze();
      console.log(JSON.stringify({
        run: k, roundWaitFrames: m.roundWait && m.roundWait.frames,
        mazeAtFrame: mazeAt, roundAtFrame: roundAt,
        deltaRn_maze_to_round: (roundAt && mazeAt) ? roundAt.rn - mazeAt.rn : null,
        deltaSteps: (roundAt && mazeAt) ? roundAt.steps - mazeAt.steps : null,
        mazeSize: maze.width + 'x' + maze.height,
        spawns: (maze.tankPositions || []).map((p) => p.playerId + '@' + p.x + ',' + p.y),
      }));
    } catch (e) {
      console.error('run ' + k + ' FAILED: ' + ((e && e.message) || e));
    } finally { await m.close(); }
  }
})();
