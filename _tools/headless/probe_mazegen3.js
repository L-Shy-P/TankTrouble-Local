const { Match } = require('./match');
(async () => {
  const m = new Match();
  try {
    await m.open({ humanIds: ['tank_a', 'tank_b'], aiCount: 0 });
    await m.pump(150, { yieldMs: 6 });

    const src = await m.eval(`(() => {
      var gm = BootCampGameMode.create();
      var out = { full: String(gm.getMaze) };
      out.mazeStatics = Object.keys(Maze).filter(function (k) { return typeof Maze[k] === 'function'; });
      out.themes = (Constants.MAZE_THEMES || {});
      return out;
    })()`);
    console.log('=== Maze 静态方法 ===');
    console.log(JSON.stringify(src.mazeStatics));
    console.log('\n=== MAZE_THEMES ===', JSON.stringify(src.themes));
    console.log('\n=== getMaze 完整源码 ===');
    console.log(src.full.slice(0, 900));

    const t = await m.eval(`(() => {
      var out = {};
      var gc = GameManager.getGameController();
      var old = gc.getMaze();
      out.old = { w: old.width, h: old.height };
      var gm = BootCampGameMode.create();
      var made = null;
      try {
        made = gm.getMaze(['tank_a', 'tank_b'], Constants.MAZE_THEMES.STANDARD);
        out.made = made ? ('w=' + made.width + ' h=' + made.height) : 'null';
      } catch (e) { out.genErr = String(e.message || e).slice(0, 150); return out; }
      if (!made) return out;

      try {
        gc.setMaze(made);
        var now = gc.getMaze();
        out.after = { w: now.width, h: now.height };
        out.changed = !(now.width === out.old.w && now.height === out.old.h) || (now !== old);
        out.sameRef = (now === old);
      } catch (e) { out.setErr = String(e.message || e).slice(0, 200); }
      return out;
    })()`);
    console.log('\n=== 生成 + setMaze ===');
    console.log(JSON.stringify(t, null, 1));

    await m.pump(40, { yieldMs: 6 });
    const s = await m.snapshot();
    console.log('\n=== setMaze 之后游戏状态 ===');
    console.log('stage      :', s.stage);
    console.log('坦克       :', JSON.stringify(s.tanks.map((x) => `${x.id}@(${x.x},${x.y})`)));
    console.log('武器       :', JSON.stringify(s.weapons.map((w) => `${w.owner}:${w.alive}s`)));
    console.log('vtErrors   :', JSON.stringify((await m.stats()).errors.slice(0, 3)));
    const maze2 = await m.maze();
    console.log('新地图尺寸 :', maze2.width + 'x' + maze2.height, ' 可达格位', maze2.reachable.length);
  } catch (e) {
    console.error('FAILED:', (e && e.stack) || e);
  } finally { await m.close(); }
})();
