(function () {
  window.__b = { n: 0, last: null };
  window.__b.mk = function (tag) {
    return { name: 'nnbridge' + tag, isReady: function () { return true; },
      decide: function () { return (tag === 'B' ? window.__b.bundleB : window.__b.bundleA) || null; } };
  };
  window.__b.setup = function () {
    var A = VantageTreeInterface.Agents;
    A.register(window.__b.mk('A'), 'A'); A.register(window.__b.mk('B'), 'B');
    A.use('nnbridgeA', 'A'); A.use('nnbridgeB', 'B');
    return 'ok';
  };
  window.__b.step = function (nodeId) {
    // ① 一次 eval 完成：读观测（带真实树）+ 写决策（上一帧策略给的 nodeId）
    var gc = GameManager.getGameController();
    var ad = VantageSandbox.createAdapter(gc, 'tank_a');
    var tree = VantageTree.getTree();
    var e = VantageObserve.encode({ adapter: ad, tree: tree, horizonSec: 10, K_death: 1, frameDt: 1 / 60 });
    var g = e.global.globalTok, h = 0;
    for (var k = 0; k < g.length; k++) h = (h * 31 + (g[k] | 0)) >>> 0;
    var d = (typeof ad.getDeathsCount === 'function') ? ad.getDeathsCount() : 0;
    window.__b.bundleA = { picks: [{ nodeId: nodeId, back: 0 }], memory: {} };
    window.__b.bundleB = window.__b.bundleA;
    window.__b.n++;
    return JSON.stringify({ h: h, dots: e.dims.total, alive: d === 0 });
  };
  window.__b.obsOnly = function () {
    var gc = GameManager.getGameController();
    var ad = VantageSandbox.createAdapter(gc, 'tank_a');
    var e = VantageObserve.encode({ adapter: ad, tree: VantageTree.getTree(), horizonSec: 10, K_death: 1, frameDt: 1 / 60 });
    var g = e.global.globalTok, h = 0;
    for (var k = 0; k < g.length; k++) h = (h * 31 + (g[k] | 0)) >>> 0;
    return JSON.stringify({ h: h, dots: e.dims.total });
  };
  window.__probe = window.__b;
  return 'installed';
})()
