const { Match } = require('./match');
(async () => {
  const m = new Match();
  try {
    await m.open({ humanIds: ['tank_a', 'tank_b'], aiCount: 0 });
    await m.pump(150, { yieldMs: 6 });

    const r = await m.eval(`(() => {
      var out = {};
      out.mazeCtors = (Maze.__metaclass && Maze.__metaclass.__constructors) ? Object.keys(Maze.__metaclass.__constructors) : null;
      out.mazeFields = (Maze.__class && Maze.__class.__fields) ? Object.keys(Maze.__class.__fields) : null;
      var gm = BootCampGameMode.create();
      out.getMazeArity = gm.getMaze ? gm.getMaze.length : null;
      out.getMazeSrc = gm.getMaze ? String(gm.getMaze).slice(0, 400) : null;
      out.gmCtors = (BootCampGameMode.__metaclass && BootCampGameMode.__metaclass.__constructors) ? Object.keys(BootCampGameMode.__metaclass.__constructors) : null;
      return out;
    })()`);
    console.log('=== Maze 工厂 ===');
    console.log('构造器:', JSON.stringify(r.mazeCtors));
    console.log('字段  :', JSON.stringify((r.mazeFields || []).slice(0, 25)));
    console.log('\n=== BootCampGameMode.getMaze ===');
    console.log('arity :', r.getMazeArity, ' ctors:', JSON.stringify(r.gmCtors));
    console.log('源码  :', r.getMazeSrc);

    // 试着生成 + 塞进活的 GameController
    const t = await m.eval(`(() => {
      var out = { tries: [] };
      var gc = GameManager.getGameController();
      var old = gc.getMaze();
      out.oldMap = { w: old.width, h: old.height };
      var gm = BootCampGameMode.create();
      // 各种可能签名
      var cands = [['gm.getMaze()', function(){ return gm.getMaze(); }],
                   ['gm.getMaze(w,h)', function(){ return gm.getMaze(old.width, old.height); }],
                   ['gm.getMaze({})', function(){ return gm.getMaze({width: old.width, height: old.height}); }]];
      var made = null, madeBy = null;
      for (var i = 0; i < cands.length; i++) {
        try {
          var v = cands[i][1]();
          out.tries.push([cands[i][0], v ? ('OK w=' + v.width + ' h=' + v.height) : 'null']);
          if (v && v.width) { made = v; madeBy = cands[i][0]; break; }
        } catch (e) { out.tries.push([cands[i][0], 'ERR ' + String(e.message || e).slice(0, 80)]); }
      }
      out.madeBy = madeBy;
      if (!made) return out;

      // 关键：能不能直接塞进活着的 GameController
      try {
        gc.setMaze(made);
        var now = gc.getMaze();
        out.after = { w: now.width, h: now.height };
        out.changed = !(now.width === out.oldMap.w && now.height === out.oldMap.h);
        out.sameObject = (now === old);
      } catch (e) { out.setMazeErr = String(e.message || e).slice(0, 200); }
      return out;
    })()`);
    console.log('\n=== 生成 + setMaze ===');
    console.log(JSON.stringify(t, null, 1));

    // setMaze 之后游戏还能不能正常跑、坦克还在不在
    await m.pump(30, { yieldMs: 6 });
    const s = await m.snapshot();
    console.log('\n=== setMaze 之后 ===');
    console.log('stage:', s.stage, ' 坦克:', JSON.stringify(s.tanks.map((x) => `${x.id}@(${x.x},${x.y})`)));
    console.log('vtErrors:', JSON.stringify((await m.stats()).errors.slice(0, 3)));
  } catch (e) {
    console.error('FAILED:', (e && e.stack) || e);
  } finally { await m.close(); }
})();
