'use strict';
/* 1-2\u2463 \u6536\u5c3e\u4efb\u52a1\u2461\uff1a\u5bfc\u822a\u8868\u5efa\u8868\u6210\u672c\u5206\u9879 + \u5916\u63a8\uff08\u53ea\u8bfb\u4ea7\u54c1\u4ee3\u7801\uff09
 *   node _tools/headless/_probe_navtab_cost.js
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
  P('=== \u6307\u7eb9 ===');
  for (const f of out.fps) P('  ' + f.file + '  ' + f.mtime + '  ' + f.md5 + '  ' + f.bytes);

  const m = new Match();
  try {
    await m.open({ humanIds: ['tank_a', 'tank_b'], aiCount: 0, vantCount: 0 });
    P('  open ok');
    const real = await m.eval(`(() => {
      var mz = GameManager.getGameController().getMaze();
      var runs = [];
      for (var i = 0; i < 5; i++) runs.push(VantageSandbox.buildNextTileTable(mz).ms);
      var t = VantageSandbox.buildNextTileTable(mz);
      return { w: t.w, h: t.h, pairs: t.pairs, computed: t.computed, skipped: t.skipped,
               runsMs: runs, bytes: t.table.length };
    })()`);
    P('  (a) \u771f\u5b9e\u8ff7\u5bab: ' + JSON.stringify(real));
    out.real = real;
    const scaled = await m.eval(`(() => {
      var res = [];
      var sizes = [[10,6],[16,10],[20,12]];
      for (var si = 0; si < sizes.length; si++) {
        var w = sizes[si][0], h = sizes[si][1];
        var mz = null;
        try { mz = Maze.createRandom(w, h, ['tank_a','tank_b'], 0); }
        catch (e) { res.push({ w: w, h: h, err: String((e && e.message) || e) }); continue; }
        var t0 = performance.now();
        var t = VantageSandbox.buildNextTileTable(mz);
        var t1 = performance.now();
        res.push({ w: w, h: h, tiles: w*h, pairs: t.pairs, computed: t.computed, skipped: t.skipped,
                   ms: Math.round((t1 - t0) * 100) / 100, bytes: t.table ? t.table.length : 0, ok: !!t.ok, err: t.err || null });
      }
      return res;
    })()`);
    P('  (a2) \u653e\u5927\u8ff7\u5bab\uff08\u6e38\u620f\u81ea\u5df1\u7684 Maze.createRandom\uff09:');
    for (const s of scaled) P('     ' + JSON.stringify(s));
    out.scaled = scaled;

    const xfer = await m.eval(`(() => {
      var mz = GameManager.getGameController().getMaze();
      var t = VantageSandbox.buildNextTileTable(mz);
      function timeIt(fn, n) {
        var best = 1e9, all = [];
        for (var i = 0; i < n; i++) {
          var a = performance.now(); fn(); var b = performance.now();
          all.push(Math.round((b - a) * 100) / 100); if (b - a < best) best = b - a;
        }
        return { bestMs: Math.round(best * 100) / 100, allMs: all };
      }
      var id = VantageSandbox.mazeIdOf ? VantageSandbox.mazeIdOf(mz) : 1;
      var ack = VantageRustBridge.setMaze({ mazeId: id, w: t.w, h: t.h, flags: t.flags, nextTile: t.table });
      var r1 = timeIt(function () { VantageRustBridge.setMaze({ mazeId: id, w: t.w, h: t.h, flags: t.flags, nextTile: t.table }); }, 5);
      var bigFlag = new Uint8Array(600), bigTab = new Uint8Array(600 * 600);
      bigFlag.fill(1); bigTab.fill(255);
      var ack2 = VantageRustBridge.setMaze({ mazeId: 999, w: 30, h: 20, flags: bigFlag, nextTile: bigTab });
      var r2 = timeIt(function () { VantageRustBridge.setMaze({ mazeId: 999, w: 30, h: 20, flags: bigFlag, nextTile: bigTab }); }, 3);
      VantageRustBridge.setMaze({ mazeId: id, w: t.w, h: t.h, flags: t.flags, nextTile: t.table });
      var ver = null; try { ver = VantageRustBridge.version(); } catch (e) { ver = String((e && e.message) || e); }
      return { abiVersion: ver, realAck: ack, realMs: r1, bigAck: ack2, bigMs: r2,
               realBytes: t.table.length, bigBytes: bigTab.length, hasMazeIdOf: typeof VantageSandbox.mazeIdOf };
    })()`);
    P('  (b) vt_set_maze \u4f20\u8f93: ' + JSON.stringify(xfer));
    out.xfer = xfer;
    P('  pageErrors: ' + JSON.stringify(m.pageErrors.slice(0, 4)));
  } catch (e) {
    out.err = String((e && e.stack) || e); P('FATAL: ' + out.err); process.exitCode = 1;
  } finally {
    fs.writeFileSync(path.join(__dirname, 'prof', 'probe_navtab_cost.json'), JSON.stringify(out, null, 1));
    try { await m.close(); } catch (e) {}
    P('[done]');
  }
})();
