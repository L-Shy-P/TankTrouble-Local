const { Match } = require('./match');
(async () => {
  const o = {};
  let m = new Match();
  await m.open({ humanIds: ['tank_a'], aiCount: 2, vantCount: 0, rng: 'flat', rngMode: 'flat' });
  await m.clearControl(); await m.pump(600, { yieldMs: 0 });
  o.a_notree = await m.eval('(function(){var d=window.__vtRng.dump();return d?d.length:0;})()');
  o.a_frames = 600;
  await m.close();
  m = new Match();
  await m.open({ humanIds: ['tank_a'], aiCount: 1, vantCount: 1, rng: 'flat', rngMode: 'flat' });
  await m.clearControl(); await m.pump(600, { yieldMs: 0 });
  o.b_tree = await m.eval('(function(){var d=window.__vtRng.dump();return d?d.length:0;})()');
  o.treeInfo = await m.eval('JSON.stringify({hasTree:!!window.VantageTree, agents:(window.VantageTree&&window.VantageTree.debugCount)?window.VantageTree.debugCount():null})');
  o.b_frames = 600;
  await m.close();
  console.log('RNG_SRC ' + JSON.stringify(o));
})();
