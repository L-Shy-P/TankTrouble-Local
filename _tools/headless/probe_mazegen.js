const os = require('os');
const { Match } = require('./match');

(async () => {
  console.log('=== 硬件 ===');
  console.log('CPU     :', (os.cpus()[0] || {}).model);
  console.log('物理核  :', os.cpus().length / 2, ' (逻辑', os.cpus().length, ')');
  console.log('内存    :', (os.totalmem() / 1073741824).toFixed(1), 'GB  可用',
    (os.freemem() / 1073741824).toFixed(1), 'GB');

  const m = new Match();
  try {
    await m.open({ humanIds: ['tank_a', 'tank_b'], aiCount: 0 });
    await m.pump(150, { yieldMs: 6 });
    const r = await m.eval(`(() => {
      var out = {};
      var gc = GameManager.getGameController();
      var mz = gc.getMaze();
      out.globalMaze = typeof Maze;
      out.globalGameMode = typeof BootCampGameMode;
      out.hasSetMaze = typeof gc.setMaze;
      out.mazeProto = Object.getOwnPropertyNames(Object.getPrototypeOf(mz)).filter(k=>k!=='constructor');
      var gm = null;
      try { gm = BootCampGameMode.create(); } catch (e) { out.gmErr = String(e); }
      out.gmMethods = gm ? Object.getOwnPropertyNames(Object.getPrototypeOf(gm)).filter(k=>k!=='constructor') : null;
      out.before = { w: mz.width, h: mz.height, reachable: (mz.reachable||[]).length, t0: (mz.tankPositions||[])[0] };
      return out;
    })()`);
    console.log('\n=== 地图生成接口 ===');
    console.log('global Maze       :', r.globalMaze);
    console.log('global BootCampGM :', r.globalGameMode, ' methods:', JSON.stringify(r.gmMethods));
    console.log('gc.setMaze        :', r.hasSetMaze);
    console.log('maze 原型方法     :', JSON.stringify(r.mazeProto));
    console.log('当前地图          :', JSON.stringify(r.before));

    // 试着生成一张新地图（几种可能的入口都试）
    const gen = await m.eval(`(() => {
      var out = {};
      var gc = GameManager.getGameController();
      var mz = gc.getMaze();
      out.attempts = [];
      var tries = [
        ['Maze.createRandomMaze', function(){ return Maze.createRandomMaze(); }],
        ['Maze.create', function(){ return Maze.create(); }],
        ['gm.getMaze', function(){ return BootCampGameMode.create().getMaze(gc.getMaze().width, gc.getMaze().height); }],
        ['mz.constructor.createRandomMaze', function(){ return mz.constructor.createRandomMaze(); }],
      ];
      for (var i = 0; i < tries.length; i++) {
        try { var v = tries[i][1](); out.attempts.push([tries[i][0], v ? 'OK ' + (v.width||'?') + 'x' + (v.height||'?') : 'null']); }
        catch (e) { out.attempts.push([tries[i][0], 'ERR ' + String(e.message||e).slice(0,90)]); }
      }
      return out;
    })()`);
    console.log('\n=== 尝试生成新地图 ===');
    for (const [n, v] of gen.attempts) console.log('  ', n.padEnd(32), v);
  } catch (e) {
    console.error('FAILED:', (e && e.stack) || e);
  } finally { await m.close(); }
})();
