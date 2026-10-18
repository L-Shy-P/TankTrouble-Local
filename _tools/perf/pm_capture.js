/**
 * pm_capture.js —— 抓一帧【真实观测载荷】（给 pm_bench.js 的同步往返基准用）
 * 用法：node _tools/perf/pm_capture.js [--players 8] [--target 208] [--out D:/vt_run/perf]
 * 产物：<out>/payload_p<players>_N<帧数>.json  —— 内容与 run_scenes_30.js 发出去的载荷同形
 *   { N, segs:{node,opp,bullet,item,global}, bytes, meta }
 * 纪律：只用项目现成的 match.js / _g1_inject.js / _segs.js；⛔ 不改游戏代码
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { Match } = require('../headless/match');
const SEGS = require('../headless/_segs.js');

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i < 0 ? d : process.argv[i + 1]; };
const OUT = arg('out', 'D:/vt_run/perf');
const PLAYERS = Number(arg('players', 8));
const TARGET = Number(arg('target', 208));
const SRC = fs.readFileSync(path.join(__dirname, '..', 'headless', '_g1_inject.js'), 'utf8');

function lcgSeq(seed, n) { let s = (seed >>> 0) || 1; const a = new Array(n); for (let i = 0; i < n; i++) { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; a[i] = s / 4294967296; } return a; }

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const m = new Match();
  try {
    await m.open({ players: PLAYERS, storm: false, control: false, rngSeq: lcgSeq(12345 + PLAYERS, 150000) });
    await m.eval(SRC);
    await m.eval('window.__g1.subscribe()');
    await m.eval('window.__g1.setup()');
    await m.eval('window.__g1.setFire(1)');
    const meta = JSON.parse(await m.eval('JSON.stringify(window.__g1.meta())'));
    const inRound = (meta.states && meta.states.IN_ROUND) || 'in round';
    let best = null, bestO = null;
    for (let f = 0; f < 900; f++) {
      const t0 = Date.now();
      const o = JSON.parse(await m.eval('window.__g1.step(0)'));
      const ms = Date.now() - t0;
      if (o.err) { console.error('step err', o.err); break; }
      if (o.state && f > 30 && o.state !== inRound) break;
      if (o.N >= 1) {
        if (!best || o.N >= TARGET) { best = { o, ms, f }; bestO = o; if (o.N >= TARGET) break; }
      }
      await m.pump(1);
    }
    if (!best) throw new Error('没有拿到任何观测帧');
    const o = bestO;
    const built = SEGS.buildSegs({
      n: o.segs.node, opp: (o.segs.opp && o.segs.opp[0]) || [], b: o.segs.bullet,
      item: o.segs.item, g: (o.segs.global && o.segs.global[0]) || []
    });
    const vio = SEGS.validateSegs(built.segs);
    if (!vio.ok) throw new Error('segs 形状不合法: ' + vio.errors.slice(0, 3).join('; '));
    const payload = {
      N: o.N, seed: 1234567, cheat: false, mem_on: 0, round_id: 'pmcap',
      segs: built.segs
    };
    const js = JSON.stringify(payload) + '\n';
    const f = path.join(OUT, `payload_p${PLAYERS}_N${o.N}.json`);
    fs.writeFileSync(f, JSON.stringify({ payload, bytes: Buffer.byteLength(js), meta: {
      players: PLAYERS, framesTo: best.f, N: o.N, segRows: o.segRows, segDims: o.segDims,
      oppBlocks: built.stats.oppBlocks, metaVID: meta.vid, stepMsCDP: best.ms
    } }, null, 0));
    console.log(JSON.stringify({ ok: true, file: f, N: o.N, bytes: Buffer.byteLength(js),
      rows: { node: built.segs.node.length, opp: built.segs.opp.length, bullet: built.segs.bullet.length,
              item: built.segs.item.length, global: built.segs.global.length },
      oppBlocks: built.stats.oppBlocks, frames: best.f, stepMsCDP: best.ms, stats: built.stats }, null, 2));
  } catch (e) {
    console.error('FAILED', (e && e.stack) || e);
    process.exitCode = 1;
  } finally { await m.close(); }
})();
