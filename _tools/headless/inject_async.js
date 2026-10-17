(function () {
  window.__a = { n: 0, obsHash: null, bundleA: null, bundleB: null };
  window.__a.mk = function (tag) {
    return { name: 'nnbridge' + tag, isReady: function () { return true; },
      decide: function () { return (tag === 'B' ? window.__a.bundleB : window.__a.bundleA) || null; } };
  };
  window.__a.setup = function () {
    var A = VantageTreeInterface.Agents;
    A.register(window.__a.mk('A'), 'A'); A.register(window.__a.mk('B'), 'B');
    A.use('nnbridgeA', 'A'); A.use('nnbridgeB', 'B');
    return 'ok';
  };
  window.__a.obs = function () {
    var gc = GameManager.getGameController();
    var ad = VantageSandbox.createAdapter(gc, 'tank_a');
    var e = VantageObserve.encode({ adapter: ad, tree: null, horizonSec: 10, K_death: 1, frameDt: 1 / 60 });
    var g = e.global.globalTok, h = 0;
    for (var k = 0; k < g.length; k++) h = (h * 31 + (g[k] | 0)) >>> 0;
    window.__a.obsHash = h;
    var d = (typeof ad.getDeathsCount === 'function') ? ad.getDeathsCount() : 0;
    return JSON.stringify({ h: h, alive: d === 0, deaths: d });
  };
  window.__a.write = function (bundleJson, nodeId) {
    try {
      var b = JSON.parse(bundleJson);
      b.picks = [{ nodeId: nodeId, back: 0 }]; b.memory = {};
      window.__a.bundleA = b; window.__a.bundleB = b; window.__a.n++;
      return JSON.stringify(b);
    } catch (e) { return 'err'; }
  };
  window.__probe = window.__a;
  return 'installed';
})()
