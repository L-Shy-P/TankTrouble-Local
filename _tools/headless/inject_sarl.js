(function () {
  var br = {};
  window.__q = { buf: [], n: 0, hasNet: false, noNet: 0 };
  try { window.__q.hasNet = !!(window.__net && typeof window.__net.forward === 'function'); } catch (e) { }
  br.mk = function (tag) {
    return { name: 'nnbridge' + tag, isReady: function () { return true; },
      decide: function (ctx) {
        var a = (tag === 'B' ? window.__q.bundleB : window.__q.bundleA) || null;
        var lp = null, v = null;
        if (window.__q.hasNet) {
          try { var o = window.__net.forward(ctx); lp = o.logp; v = o.value; } catch (e) { }
        } else { window.__q.noNet++; }
        try {
          window.__q.buf.push({
            f: window.__q.n, tag: tag,
            a: a ? JSON.stringify({ picks: a.picks || null, memory: a.memory || null }) : null,
            r: window.__q.alive ? 1 : 0,
            lp: lp, v: v, s: window.__q.obsHash || null,
            alive: !!window.__q.alive
          });
        } catch (e) { }
        return a;
      } };
  };
  br.setup = function () {
    var A = VantageTreeInterface.Agents;
    A.register(br.mk('A'), 'A'); A.register(br.mk('B'), 'B');
    A.use('nnbridgeA', 'A'); A.use('nnbridgeB', 'B');
    return JSON.stringify({ hasInPageNet: window.__q.hasNet });
  };
  br.tick = function () {
    try {
      var t = VantageTree.getTree();
      var r = VantageTree.collectAgentNodes(t); var arr = Array.isArray(r) ? r : [];
      var grow = null, deep = null;
      for (var i = 0; i < arr.length; i++) { var o = arr[i]; if (!o) continue;
        if (grow === null && o.hasGrown === false && !o.invalid && !o.exhausted) grow = o.id;
        if (deep === null && o.depth >= 1 && !o.invalid && !o.exhausted) deep = o.id; }
      window.__q.bundleA = grow === null ? null : { picks: [{ nodeId: grow, back: 0 }], memory: {} };
      window.__q.bundleB = deep === null ? null : { picks: [{ nodeId: deep, back: 0 }], memory: {} };
      var gc = GameManager.getGameController();
      var ad = VantageSandbox.createAdapter(gc, 'tank_a');
      var d = (typeof ad.getDeathsCount === 'function') ? ad.getDeathsCount() : 0;
      window.__q.alive = (d === 0);
      var e = VantageObserve.encode({ adapter: ad, tree: null, horizonSec: 10, K_death: 1, frameDt: 1 / 60 });
      var h = 0, g = e.global.globalTok;
      for (var k = 0; k < g.length; k++) { h = (h * 31 + (g[k] | 0)) >>> 0; }
      window.__q.obsHash = h;
      window.__q.n++;
    } catch (err) { window.__q.err = String(err.message || err).slice(0, 60); }
    window.requestAnimationFrame(br.tick);
  };
  br.start = function () { window.requestAnimationFrame(br.tick); return 'started'; };
  window.__probe = br;
  return 'installed';
})()
