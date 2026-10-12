'use strict';
/* 回归烟测：现有工具用的几种 open() 配参在改完之后还能不能开起来
 * （collect.js: humanIds=['tank_a'], aiCount=1, vantCount=1；
 *   parallel_bench.js / stage1_rollout.js: aiCount=0, vantCount=1）
 *
 *   node _tools/headless/_smoke_open_opts.js
 */
const { Match } = require('./match');

const CASES = [
  { name: 'collect.js', opts: { humanIds: ['tank_a'], aiCount: 1, vantCount: 1 } },
  { name: 'parallel_bench.js / stage1_rollout.js', opts: { humanIds: ['tank_a'], aiCount: 0, vantCount: 1 } },
  { name: 'match.js 默认', opts: { humanIds: ['tank_a'], aiCount: 1, vantCount: 0 } },
];

(async () => {
  let bad = 0;
  for (const c of CASES) {
    const m = new Match();
    try {
      const t0 = Date.now();
      await m.open(Object.assign({}, c.opts));
      const s0 = await m.snapshot();
      await m.setControl({ fwd: true });
      await m.fast(20);
      const s1 = await m.snapshot();
      await m.clearControl();
      const moved = Math.hypot(s1.tanks.find((t) => t.id === 'tank_a').x - s0.tanks.find((t) => t.id === 'tank_a').x,
                               s1.tanks.find((t) => t.id === 'tank_a').y - s0.tanks.find((t) => t.id === 'tank_a').y);
      console.log(JSON.stringify({
        case: c.name, openMs: Date.now() - t0,
        roundWaitFrames: m.roundWait && m.roundWait.frames,
        installControl: 'ok', bootstrap: m.bootstrap,
        stateBefore: s0.stage, players: s0.players,
        tankMove20帧: +moved.toFixed(3),
        rngMode: m.rngMode, rngState: await m.eval('window.__vtRng.state()'),
        pageErrors: m.pageErrors.slice(0, 2),
      }));
      if (!(moved > 0.01)) { console.error('⚠️ 开坦克 20 帧没动：' + c.name); bad++; }
    } catch (e) {
      bad++;
      console.error('FAILED [' + c.name + ']: ' + ((e && e.message) || e));
    } finally { await m.close(); }
  }
  console.log(bad === 0 ? '烟测结论: 全部通过' : ('烟测结论: ' + bad + ' 个失败'));
  if (bad) process.exitCode = 1;
})();
