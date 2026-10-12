'use strict';
/* \u5bfc\u822a\u8868\u5efa\u8868\u5f00\u9500 \u2014\u2014 \u2460\u9875\u5185\u8ba1\u65f6\u51bb\u7ed3\u6838\u5b9e + \u2461\u771f\u5b9e\u8ff7\u5bab\u4e0a\u7684\u3010\u51b7/\u70ed + \u8ff7\u5bab\u5c3a\u5bf8\u3011\u5206\u89e3\uff08\u5168\u90e8 Node \u4fa7\u5899\u949f\uff09
 *   node _tools/headless/_probe_navtab_cost3.js
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Match } = require('./match');
const P = (s) => console.log(s);

(async () => {
  const out = { fps: [] };
  for (const rel of ['game_core/js/vantage_sandbox.js', 'game_core/js/vantage_rust_bridge.js',
                     'game_core/js/wasm/vantage_core.wasm']) {
    const p = path.join(__dirname, '..', '..', rel);
    const st = fs.statSync(p);
    out.fps.push({ file: rel, mtime: st.mtime.toISOString(), bytes: st.size,
      md5: crypto.createHash('md5').update(fs.readFileSync(p)).digest('hex') });
  }
  for (const f of out.fps) P('  ' + f.file + '  ' + f.mtime + '  ' + f.md5);

  const m = new Match();
  const nodeTimed = async (expr) => {
    const a = process.hrtime.bigint();
    const v = await m.eval(expr);
    const b = process.hrtime.bigint();
    return { ms: Number(b - a) / 1e6, v: v };
  };
  try {
    await m.open({ humanIds: ['tank_a', 'tank_b'], aiCount: 0, vantCount: 0 });
    P('  open ok');
    // (0) \u9875\u5185\u65f6\u949f\u77e9\u9635
    const clock = await m.eval(`(() => {
      var p0 = performance.now(); var d0 = Date.now();
      var s = 0; for (var i = 0; i < 20000000; i++) s += (i & 7);
      var p1 = performance.now(); var d1 = Date.now();
      var nd = (new Date()).getTime();
      return { perfDelta: p1 - p0, dateDelta: d1 - d0, perfFrac: (p0 % 1) !== 0, dateFrac: (d0 % 1) !== 0,
               newDateFrac: (nd % 1) !== 0, vtT: window.__vt ? window.__vt.t : null,
               hasVtStep: typeof window.__vtStep, perf0: p0, date0: d0, sink: s };
    })()`);
    const clockNode = await nodeTimed(`(() => { var s = 0; for (var i = 0; i < 20000000; i++) s += (i & 7); return s; })()`);
    P('  (0) \u9875\u5185\u65f6\u949f: ' + JSON.stringify(clock));
    P('  (0b) \u540c\u4e00\u4e2a\u5faa\u73af\u3001Node \u5899\u949f: ' + clockNode.ms.toFixed(2) + ' ms');
    out.clock = clock; out.clockNodeMs = clockNode.ms;

    // (1) \u771f\u5b9e\u8ff7\u5bab\uff1a\u9875\u5185**\u7b2c\u4e00\u6b21**\u8c03\u7528\uff08\u51b7 JIT\uff09\u2192 \u70ed\u5747
    const cold1 = await nodeTimed(`(() => { var mz = GameManager.getGameController().getMaze();
      var t = VantageSandbox.buildNextTileTable(mz);
      return { w: t.w, h: t.h, pairs: t.computed, inPageMs: t.ms }; })()`);
    P('  (1) \u771f\u5b9e\u8ff7\u5bab \u7b2c1\u6b21(\u51b7): ' + cold1.ms.toFixed(1) + ' ms  ' + JSON.stringify(cold1.v));
    const warmReal = [];
    for (let i = 0; i < 5; i++) {
      const r = await nodeTimed(`(() => { var mz = GameManager.getGameController().getMaze();
        return VantageSandbox.buildNextTileTable(mz).computed; })()`);
      warmReal.push(Math.round(r.ms * 10) / 10);
    }
    P('  (1b) \u771f\u5b9e\u8ff7\u5bab \u70ed5\u6b21: ' + JSON.stringify(warmReal));
    out.realCold = cold1.ms; out.realWarm = warmReal;

    // (2) 16x10 / 20x12\u771f\u5b9e\u8ff7\u5bab\uff1a\u7b2c\u4e00\u6b21 vs \u70ed\u5747
    for (const sz of [[16, 10], [20, 12]]) {
      const first = await nodeTimed(`(() => { var mz = Maze.createRandom(${sz[0]}, ${sz[1]}, ['tank_a','tank_b'], 0);
        var t = VantageSandbox.buildNextTileTable(mz); window.__pnt = t;
        return { w: t.w, h: t.h, pairs: t.computed }; })()`);
      const warm = [];
      for (let i = 0; i < 3; i++) {
        const r = await nodeTimed(`(() => { var mz = Maze.createRandom(${sz[0]}, ${sz[1]}, ['tank_a','tank_b'], 0);
          return VantageSandbox.buildNextTileTable(mz).computed; })()`);
        warm.push(Math.round(r.ms * 10) / 10);
      }
      P('  (2) ${sz[0]}x${sz[1]}: \u7b2c1\u6b21=' + first.ms.toFixed(1) + ' ms ' + JSON.stringify(first.v) + '  \u70ed3\u6b21=' + JSON.stringify(warm));
      out['s' + sz[0] + 'x' + sz[1]] = { first: Math.round(first.ms * 10) / 10, warm: warm, pairs: first.v.pairs };
    }
    P('  pageErrors: ' + JSON.stringify(m.pageErrors.slice(0, 3)));
  } catch (e) {
    out.err = String((e && e.stack) || e); P('FATAL: ' + out.err); process.exitCode = 1;
  } finally {
    fs.writeFileSync(path.join(__dirname, 'prof', 'probe_navtab_cost3.json'), JSON.stringify(out, null, 1));
    try { await m.close(); } catch (e) {}
    P('[done]');
  }
})();
