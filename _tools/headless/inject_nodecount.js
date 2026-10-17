(function () {
  window.__nc = { n: 0, counts: [] };
  window.__nc.tick = function () {
    if (!window.__nc.on) return;
    try {
      var t = VantageTree.getTree();
      var r = VantageTree.collectAgentNodes(t);
      var arr = Array.isArray(r) ? r : [];
      window.__nc.counts.push(arr.length); window.__nc.n++;
    } catch (e) { }
    window.requestAnimationFrame(window.__nc.tick);
  };
  window.__nc.start = function () { window.__nc.on = true; window.requestAnimationFrame(window.__nc.tick); return 'ok'; };
  window.__nc.stat = function () {
    var c = window.__nc.counts.slice().sort(function (a, b) { return a - b; });
    var n = c.length;
    if (!n) return '{}';
    return JSON.stringify({ samples: n, min: c[0], p25: c[Math.floor(n * 0.25)], median: c[Math.floor(n * 0.5)], p75: c[Math.floor(n * 0.75)], max: c[n - 1] });
  };
  return 'installed';
})()
