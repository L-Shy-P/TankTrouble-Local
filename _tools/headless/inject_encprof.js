(function () {
  window.__ep = { n: 0, tEnc: 0, tPump: 0, last: 0, series: [], maxDots: 0 };
  window.__ep.tick = function () {
    if (!window.__ep.on) return;
    try {
      var gc = GameManager.getGameController();
      var ad = VantageSandbox.createAdapter(gc, 'tank_a');
      var t0 = performance.now();
      var e = VantageObserve.encode({ adapter: ad, tree: VantageTree.getTree(), horizonSec: 10, K_death: 1, frameDt: 1 / 60 });
      var t1 = performance.now();
      window.__ep.tEnc += (t1 - t0); window.__ep.last = (t1 - t0);
      var d = e.dims.total;
      if (d > window.__ep.maxDots) window.__ep.maxDots = d;
      if (window.__ep.n % 50 === 0) window.__ep.series.push({ n: window.__ep.n, dots: d, ms: Math.round((t1 - t0) * 100) / 100 });
      window.__ep.n++;
    } catch (err) { window.__ep.err = String(err.message || err).slice(0, 60); }
    window.requestAnimationFrame(window.__ep.tick);
  };
  window.__ep.start = function () { window.__ep.on = true; window.requestAnimationFrame(window.__ep.tick); return 'started'; };
  window.__ep.stat = function () {
    return JSON.stringify({ n: window.__ep.n, tEncMs: Math.round(window.__ep.tEnc), perFrameMs: window.__ep.n ? Math.round(window.__ep.tEnc / window.__ep.n * 100) / 100 : null,
      maxDots: window.__ep.maxDots, series: window.__ep.series.slice(-6), err: window.__ep.err });
  };
  return 'installed';
})()
