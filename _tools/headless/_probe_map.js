const { Match } = require('./match');
(async () => {
  const m = new Match();
  try {
    await m.open({ humanIds:['tank_a','tank_b'], aiCount:0, vantCount:0 });
    const r = await m.eval(`(() => {
      var out = {};
      var C = Constants.MAZE;
      out.consts = {};
      for (var k in C) { if (typeof C[k] === 'number') out.consts[k] = C[k]; }
      var mz = GameManager.getGameController().getMaze();
      out.size = { w: mz.width, h: mz.height };
      out.has = {};
      for (var f of ['isPositionInsideMaze','isTankStateInsideMaze','getTiles','getWalls','getFloors',
                     'getSpaces','getTileBounds','getReachable','getDistancesFromPosition',
                     'getDistanceBetweenPositions','getDistances']) {
        out.has[f] = typeof mz[f];
      }
      // 逐格测 isPositionInsideMaze，看能不能当墙判定
      var grid = [];
      for (var y = -1; y <= mz.height; y++) {
        var row = '';
        for (var x = -1; x <= mz.width; x++) {
          var v = null;
          try { v = mz.isPositionInsideMaze({x:x, y:y}); } catch(e) { v = 'ERR'; }
          row += (v === true ? '.' : (v === false ? '#' : '?'));
        }
        grid.push(row);
      }
      out.grid = grid;
      try { out.tilesSample = JSON.stringify(mz.getTiles()).slice(0,300); } catch(e){ out.tilesErr=String(e); }
      try { out.reachableSample = JSON.stringify(mz.reachable).slice(0,200); } catch(e){}
      return out;
    })()`);
    console.log('迷宫尺寸上限常量:', JSON.stringify(r.consts));
    console.log('本局迷宫:', JSON.stringify(r.size));
    console.log('可用方法:', JSON.stringify(r.has));
    console.log('\n地图网格（isPositionInsideMaze）: "."=内部(空) "#"=外部(墙)');
    for (const row of r.grid) console.log('   ', row);
    console.log('\ngetTiles 样例:', r.tilesSample);
    console.log('reachable 样例:', r.reachableSample);
  } catch(e){ console.error('FAILED:', (e&&e.stack)||e); }
  finally { await m.close(); }
})();
