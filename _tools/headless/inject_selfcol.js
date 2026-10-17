(function () {
  window.__sc = { buf: [], on: false, n: 0, seg: 0, lastCommits: null, aSamples: [] };
  window.__sc.hash = function (a) { var h = 2166136261; for (var i = 0; i < a.length; i++) { h ^= (a[i] | 0); h = (h * 16777619) >>> 0; } return h; };
  window.__sc.tick = function () {
    if (!window.__sc.on) return;
    try {
      var gc = GameManager.getGameController();
      var ad = VantageSandbox.createAdapter(gc, 'tank_a');
      var e = VantageObserve.encode({ adapter: ad, tree: null, horizonSec: 10, K_death: 1, frameDt: 1 / 60 });
      var g = e.global;
      var rec = { t: window.__sc.n++, d: e.dims.total, h: window.__sc.hash(g.globalTok.concat(g.oppTok)) };
      window.__sc.buf.push(rec);
      var t = VantageTree.getTree();
      var st = (t && t.stats) || {};
      var c = st.commits;
      if (c !== undefined && c !== null) {
        if (window.__sc.lastCommits !== null && c !== window.__sc.lastCommits) {
          window.__sc.seg++;
          if (window.__sc.seg % 4 === 0) window.__sc.aSamples.push({ f: window.__sc.n, commits: c });
        }
        window.__sc.lastCommits = c;
      }
    } catch (err) { window.__sc.err = String(err.message || err).slice(0, 60); }
    window.requestAnimationFrame(window.__sc.tick);
  };
  window.__sc.start = function () { window.__sc.on = true; window.requestAnimationFrame(window.__sc.tick); return 'started'; };
  window.__sc.ref = function (n2) { return JSON.stringify({ n: window.__sc.n, buf: window.__sc.buf.length, seg: window.__sc.seg, a: window.__sc.aSamples.length, sample: window.__sc.buf.slice(n2 || 0, (n2 || 0) + 3), err: window.__sc.err }); };
  return 'installed';
})()
