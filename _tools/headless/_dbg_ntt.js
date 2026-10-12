'use strict';
const { Match } = require('./match');
(async () => {
  const m = new Match();
  try {
    await m.open({ humanIds: ['tank_a', 'tank_b'], aiCount: 0, vantCount: 0 });
    const d = await m.eval(`(() => {
      var mz = GameManager.getGameController().getMaze();
      var r = VantageSandbox.buildNextTileTable(mz);
      var w = r.w, h = r.h, n = w * h, t = r.table, tiles = mz.getTiles();
      function legal(fx, fy, tx, ty) {
        var dx = tx - fx, dy = ty - fy;
        function L(x, y) { return tiles[x][y][2] === 0; }
        function T(x, y) { return tiles[x][y][1] === 0; }
        if (dx === -1 && dy === 0) return fx > 0 && L(fx, fy);
        if (dx === 1 && dy === 0) return fx < w - 1 && L(fx + 1, fy);
        if (dx === 0 && dy === -1) return fy > 0 && T(fx, fy);
        if (dx === 0 && dy === 1) return fy < h - 1 && T(fx, fy + 1);
        return null;
      }
      // 取 (0,0) -> (2,0)
      var fi = 0, ti = 2;
      var chain = [], cx = 0, cy = 0, g = 0;
      chain.push({ at: [cx, cy], v: t[(cy * w + cx) * n + ti] });
      while (g < 6) {
        var nv = t[(cy * w + cx) * n + ti];
        if (nv === 255) { chain.push({ dead: true }); break; }
        var nx = nv % w, ny = (nv - nx) / w;
        chain.push({ step: [cx, cy, '->', nx, ny], legal: legal(cx, cy, nx, ny), tilesFrom: tiles[cx][cy], tilesTo: tiles[nx][ny] });
        cx = nx; cy = ny; g++;
        if (cx === 2 && cy === 0) break;
      }
      var path = mz.getShortestPathWithGraph({ x: 0, y: 0 }, { x: 2, y: 0 });
      return { w: w, h: h, tilesFirst3x2: [tiles[0][0], tiles[0][1], tiles[1][0], tiles[1][1], tiles[2][0]],
               chain: chain, path: path };
    })()`);
    console.log(JSON.stringify(d, null, 1));
  } catch (e) { console.error('FATAL', e); }
  finally { try { await m.close(); } catch (e) {} }
})();
