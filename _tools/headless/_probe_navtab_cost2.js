'use strict';
/* 1-2\u2463 \u6536\u5c3e\u2461 \u7b2c 2 \u7248\uff1a\u5148\u9a8c\u3010\u8ba1\u65f6\u5668\u3011\u672c\u8eab\uff08\u4e0a\u4e00\u7248\u7528\u9875\u5185 performance.now\uff0c\u7ed3\u679c 56k \u6b21 Dijkstra \u62a5 0ms = \u4e0d\u53ef\u80fd\uff09
 *   \u6240\u4ee5\u6539\u6210\uff1a\u2460 \u5148\u9a8c performance.now/Date.now \u5728\u9875\u5185\u662f\u5426\u4f1a\u8d70
 *             \u2461 \u518d\u7528\u3010Node \u4fa7\u5899\u949f\u3011\u5305\u4f4f m.eval \u6765\u6d4b
 *   node _tools/headless/_probe_navtab_cost2.js
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Match } = require('./match');
const P = (s) => console.log(s);

(async () => {
  const out = { fps: [] };
  for (const rel of ['game_core/js/vantage_sandbox.js', 'game_core/js/vantage_rust_bridge.js']) {
    const p = path.join(__dirname, '..', '..', rel);
    const st = fs.statSync(p);
    out.fps.push({ file: rel, mtime: st.mtime.toISOString(), bytes: st.size,
      md5: crypto.createHash('md5').update(fs.readFileSync(p)).digest('hex') });
  }
  for (const f of out.fps) P('  ' + f.file + '  ' + f.mtime + '  ' + f.md5);

  const m = new Match();
  const nodeMs = async (expr, n) => {
    const all = [];
    for (let i = 0; i < n; i++) {
      const a = process.hrtime.bigint();
      const v = await m.eval(expr);
      const b = process.hrtime.bigint();
      all.push({ ms: Number(b - a) / 1e6, v: v });
    }
    all.sort((x, y) => x.ms - y.ms);
    return { bestMs: Math.round(all[0].ms * 100) / 100, allMs: all.map((x) => Math.round(x.ms * 100) / 100), first: all[all.length - 1].v };
  };
  try {
    await m.open({ humanIds: ['tank_a', 'tank_b'], aiCount: 0, vantCount: 0 });
    P('  open ok');
    const clock = await m.eval(`(() => {
      var a = performance.now(); var s = 0; for (var i = 0; i < 20000000; i++) s += i;
      var b = performance.now();
      var c = Date.now(); var s2 = 0; for (var j = 0; j < 20000000; j++) s2 += j; var d = Date.now();
      return { perfDelta: b - a, dateDelta: d - c, perfNow: a, dateNow: c, vtT: window.__vt ? window.__vt.t : null };
    })()`);
    P('  (0) \u8ba1\u65f6\u5668\u6d3b\u6027\u9a8c\u8bc1: ' + JSON.stringify(clock));
    out.clock = clock;

    const real = await m.eval(`(() => {
      var mz = GameManager.getGameController().getMaze();
      var t = VantageSandbox.buildNextTileTable(mz);
      return { w: t.w, h: t.h, pairs: t.pairs, computed: t.computed, bytes: t.table.length,
               inPageMs: t.ms, hasFlags: !!t.flags };
    })()`);
    P('  (1) \u771f\u5b9e\u8ff7\u5bab: ' + JSON.stringify(real));
    const realT = await nodeMs(`(() => {
      var mz = GameManager.getGameController().getMaze();
      var t = VantageSandbox.buildNextTileTable(mz);
      return t.computed;
    })()`, 5);
    P('  (1b) \u771f\u5b9e\u8ff7\u5bab\u5efa\u8868\uff08Node \u5899\u949f\uff09: ' + JSON.stringify(realT));
    out.real = real; out.realT = realT;

    for (const sz of [[10, 6], [16, 10], [20, 12]]) {
      const w = sz[0], h = sz[1];
      const e = await nodeMs(`(() => {
        var mz = Maze.createRandom(${w}, ${h}, ['tank_a','tank_b'], 0);
        var t = VantageSandbox.buildNextTileTable(mz);
        window.__probeNavLast = t;
        return { w: t.w, h: t.h, pairs: t.pairs, computed: t.computed, bytes: t.table.length, ok: !!t.ok, err: t.err || null };
      })()`, 3);
      P('  (2) ${w}x${h} \u5efa\u8868\uff08Node \u5899\u949f\uff09: ' + JSON.stringify(e));
      out['scaled_' + w + 'x' + h] = e;
    }
    const hold = await m.eval(`(() => { var t = window.__probeNavLast; return { w: t.w, h: t.h, bytes: t.table.length, hasFlags: !!t.flags }; })()`);
    P('  (3) \u4fdd\u7559\u6700\u540e\u4e00\u5f20\u8868\uff08\u7ed9\u4f20\u8f93\u6d4b\u7528\uff09: ' + JSON.stringify(hold));
    const bigMs = await nodeMs(`(() => {
      var h = window.__probeNavLast;
      var ack = VantageRustBridge.setMaze({ mazeId: 777, w: h.w, h: h.h, flags: h.flags, nextTile: h.table });
      return !!(ack && ack.ok);
    })()`, 5);
    P('  (4) vt_set_maze \u4f20\u8f93\uff08Node \u5899\u949f\uff0c' + hold.w + 'x' + hold.h + ' / ' + hold.bytes + 'B\uff09: ' + JSON.stringify(bigMs));
    out.xfer = bigMs;
    const restore = await m.eval(`(() => {
      var mz = GameManager.getGameController().getMaze();
      var t = VantageSandbox.buildNextTileTable(mz);
      var id = VantageSandbox.mazeIdOf ? VantageSandbox.mazeIdOf(mz) : 1;
      var ack = VantageRustBridge.setMaze({ mazeId: id, w: t.w, h: t.h, flags: t.flags, nextTile: t.table });
      return !!(ack && ack.ok);
    })()`);
    P('  (5) \u6062\u590d\u771f\u5b9e\u8868: ' + JSON.stringify(restore));
    out.restore = restore;
    P('  pageErrors: ' + JSON.stringify(m.pageErrors.slice(0, 4)));
  } catch (e) {
    out.err = String((e && e.stack) || e); P('FATAL: ' + out.err); process.exitCode = 1;
  } finally {
    fs.writeFileSync(path.join(__dirname, 'prof', 'probe_navtab_cost2.json'), JSON.stringify(out, null, 1));
    try { await m.close(); } catch (e) {}
    P('[done]');
  }
})();
