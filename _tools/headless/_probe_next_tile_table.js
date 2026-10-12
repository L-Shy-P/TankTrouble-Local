'use strict';
/* 1-2\u2463 \u300c\u4e0b\u4e00\u683c\u8868\u300d\u9a8c\u8bc1\uff1a\u8bc1\u660e JS \u9884\u8ba1\u7b97\u7684\u8868 \u2261 \u6e38\u620f\u81ea\u5df1\u7684 getShortestPathWithGraph
 *   \u72ec\u7acb\u6027\u68c0\u67e5\u4e0d\u91cd\u590d\u540c\u4e00\u4e2a\u8c03\u7528\uff1a
 *     \u2460 \u9010\u683c\u5bf9\u62cd\uff1a\u8868\u91cc\u7684\u6bcf\u4e2a\u975e 255 \u6761\u76ee\uff0c\u5fc5\u987b == \u73b0\u573a\u8c03 getShortestPathWithGraph \u7684 [0]
 *     \u2461 \u884c\u8d70\u6cd5\uff1a\u4ece from \u6cbf\u8868\u8fde\u7eed\u8d70\uff0c\u5fc5\u987b\u80fd\u5230\u8fbe to\uff0c\u4e14\u6bcf\u4e00\u6b65\u90fd\u662f\u3010\u5408\u6cd5\u7684 8 \u8fde\u901a\u79fb\u52a8\u3011\uff08\u81ea\u5df1\u67e5\u5899\u6807\u5fd7\u72ec\u7acb\u5224\uff09
 *     \u2462 \u54e8\u5175\uff1a\u4e0d\u53ef\u8fbe/\u8ddd\u79bb\u22641 \u7684\u683c\u5bf9\u5fc5\u987b\u662f 255
 * \u7528\u6cd5\uff1anode _tools/headless/_probe_next_tile_table.js
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Match } = require('./match');
const P = (s) => console.log(s);

(async () => {
  const out = { fps: [] };
  for (const rel of ['game_core/js/vantage_sandbox.js', 'game_core/js/418577fd210ad079ea3d1e5e04050fe0.js']) {
    const p = path.join(__dirname, '..', '..', rel);
    const st = fs.statSync(p);
    out.fps.push({ file: rel, mtime: st.mtime.toISOString(), md5: crypto.createHash('md5').update(fs.readFileSync(p)).digest('hex') });
  }
  P('=== 指纹 ===');
  for (const f of out.fps) P(`  ${f.file}  ${f.mtime}  ${f.md5}`);

  const m = new Match();
  try {
    await m.open({ humanIds: ['tank_a', 'tank_b'], aiCount: 0, vantCount: 0 });
    const built = await m.eval(`(() => {
      var mz = GameManager.getGameController().getMaze();
      var r = VantageSandbox.buildNextTileTable(mz);
      window.__ntt = r;
      return { ok: r.ok, w: r.w, h: r.h, pairs: r.pairs, computed: r.computed, skipped: r.skipped, ms: r.ms, err: r.err || null };
    })()`);
    P('  建表: ' + JSON.stringify(built));
    out.built = built;
    // ① 逐条对拍 + ② 行走法 + ③ 哨兵（全部在页面里做，避免大表过 CDP）
    const check = await m.eval(`(() => {
      var mz = GameManager.getGameController().getMaze();
      var r = window.__ntt;
      if (!r || !r.ok) return { err: 'table not built' };
      var w = r.w, h = r.h, n = w * h, t = r.table;
      var tiles = mz.getTiles();
      function reachable(x, y) { return mz.getDistancesFromPosition({ x: x, y: y }) !== false; }
      // \u5408\u6cd5\u7684 8 \u8fde\u901a\u79fb\u52a8\uff08\u81ea\u5df1\u6838\u5899\u6807\u5fd7\uff0c\u4e0d\u7528\u6e38\u620f\u7684\uff09
      function legal(fx, fy, tx, ty) {
        var dx = tx - fx, dy = ty - fy;
        if (Math.abs(dx) > 1 || Math.abs(dy) > 1 || (dx === 0 && dy === 0)) return false;
        function L(x, y) { return tiles[x][y][2] === 0; }   // \u5de6\u5899\u4e0d\u5b58\u5728
        function T(x, y) { return tiles[x][y][1] === 0; }   // \u4e0a\u5899\u4e0d\u5b58\u5728
        if (dx === -1 && dy === 0) return fx > 0 && L(fx, fy);
        if (dx === 1 && dy === 0) return fx < w - 1 && L(fx + 1, fy);
        if (dx === 0 && dy === -1) return fy > 0 && T(fx, fy);
        if (dx === 0 && dy === 1) return fy < h - 1 && T(fx, fy + 1);
        if (dx === -1 && dy === -1) return fx > 0 && fy > 0 && L(fx, fy) && L(fx, fy - 1) && T(fx, fy) && T(fx - 1, fy - 1);
        if (dx === 1 && dy === -1) return fx < w - 1 && fy > 0 && L(fx + 1, fy) && L(fx + 1, fy - 1) && T(fx, fy) && T(fx + 1, fy - 1);
        if (dx === -1 && dy === 1) return fx > 0 && fy < h - 1 && L(fx, fy) && L(fx, fy + 1) && T(fx, fy + 1) && T(fx - 1, fy + 1);
        if (dx === 1 && dy === 1) return fx < w - 1 && fy < h - 1 && L(fx + 1, fy) && L(fx + 1, fy + 1) && T(fx, fy + 1) && T(fx + 1, fy + 1);
        return false;
      }
      var nz = 0, eq = 0, neq = [], walkBad = [], sentinelBad = 0, walkOk = 0, sentinelOk = 0;
      for (var fi = 0; fi < n; fi++) {
        var fx = fi % w, fy = (fi - fx) / w;
        for (var ti = 0; ti < n; ti++) {
          var v = t[fi * n + ti];
          var tx = ti % w, ty = (ti - tx) / w;
          var fr = reachable(fx, fy), tr = reachable(tx, ty);
          var d = fr ? mz.getDistanceToPosition(mz.getDistancesFromPosition({ x: fx, y: fy }), { x: tx, y: ty }) : false;
          var need = fr && tr && d !== false && d > 1;
          if (!need) {
            if (v !== 255) sentinelBad++; else sentinelOk++;
            continue;
          }
          nz++;
          var path = mz.getShortestPathWithGraph({ x: fx, y: fy }, { x: tx, y: ty });
          var expect = (path && path.length) ? ((path[0].y * w + path[0].x) & 0xff) : 255;
          if (v === expect) eq++; else if (neq.length < 6) neq.push({ from: [fx, fy], to: [tx, ty], got: v, want: expect, d: d });
          // \u884c\u8d70\u6cd5
          // ★ 行走法：表只在「4 连通距离 ≥2」时才有条目（距离 ≤1 真游戏走 tank-exact
          //   分支、不查最短路）⟹ 行走**允许在离目标 1 格处停住（255）**，不是失败。
          var cx = fx, cy = fy, steps = 0, okWalk = true, stopDist = null;
          for (;;) {
            if (cx === tx && cy === ty) { stopDist = 0; break; }
            if (Math.abs(cx - tx) + Math.abs(cy - ty) === 1) { stopDist = 1; break; }
            var nv = t[(cy * w + cx) * n + ti];
            if (nv === 255) { okWalk = false; break; }
            var nx = nv % w, ny = (nv - nx) / w;
            if (!legal(cx, cy, nx, ny)) { okWalk = false; break; }
            cx = nx; cy = ny; steps++;
            if (steps > n + 2) { okWalk = false; break; }
          }
          if (okWalk && stopDist !== null) walkOk++; else if (walkBad.length < 6) walkBad.push({ from: [fx, fy], to: [tx, ty], steps: steps, at: [cx, cy], stopDist: stopDist });
        }
      }
      return { n: n, nz: nz, eq: eq, neq: neq, walkOk: walkOk, walkBad: walkBad, sentinelOk: sentinelOk, sentinelBad: sentinelBad };
    })()`);
    P('  对拍: ' + JSON.stringify(check));
    out.check = check;
    out.verdict = (check.eq === check.nz && check.walkOk === check.nz && check.sentinelBad === 0 && check.neq.length === 0)
      ? 'PASS（表 == 游戏API；行走法全部到达；哨兵全对）' : 'FAIL';
    P('  ★ 判定: ' + out.verdict);
    P('  pageErrors: ' + JSON.stringify(m.pageErrors.slice(0, 4)));
  } catch (e) {
    out.err = String((e && e.stack) || e); P('FATAL: ' + out.err); process.exitCode = 1;
  } finally {
    fs.writeFileSync(path.join(__dirname, 'prof', 'probe_next_tile_table.json'), JSON.stringify(out, null, 1));
    try { await m.close(); } catch (e) {}
    P('[done]');
  }
})();
