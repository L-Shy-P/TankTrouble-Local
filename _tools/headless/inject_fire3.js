(function () {
  var br = {};
  window.__g = { mode: 'shoot', xFound: 0, xNull: 0, nodeCounts: [], n: 0 };
  br.mk = function (tag) {
    return { name: 'nnbridge' + tag, isReady: function () { return true; },
      decide: function () { return (tag === 'B' ? window.__g.bundleB : window.__g.bundleA) || null; } };
  };
  br.setup = function () {
    var A = VantageTreeInterface.Agents;
    A.register(br.mk('A'), 'A'); A.register(br.mk('B'), 'B');
    A.use('nnbridgeA', 'A'); A.use('nnbridgeB', 'B');
    return 'ok';
  };
  br.step = function () {
    try {
      var t = VantageTree.getTree();
      var r = VantageTree.collectAgentNodes(t); var arr = Array.isArray(r) ? r : [];
      window.__g.nodeCounts.push(arr.length);
      var X = null;
      for (var i = 0; i < arr.length; i++) { var o = arr[i]; if (o && o.depth >= 1 && !o.invalid && !o.exhausted) { X = o.id; break; } }
      if (X === null) { window.__g.xNull++; } else { window.__g.xFound++; }
      var picks = (X === null) ? null : (window.__g.mode === 'shoot'
        ? [{ nodeId: X, back: 0 }, { nodeId: X, back: 0 }]
        : [{ nodeId: X, back: 0 }]);
      var b = picks ? { picks: picks, memory: {} } : null;
      window.__g.bundleA = b; window.__g.bundleB = b;
      window.__g.n++;
      return 1;
    } catch (e) { return 'err'; }
  };
  br.stat = function () {
    var nc = window.__g.nodeCounts.slice().sort(function (a, b) { return a - b; });
    return JSON.stringify({ mode: window.__g.mode, n: window.__g.n, xFound: window.__g.xFound, xNull: window.__g.xNull,
      nodeMin: nc[0], nodeMed: nc[Math.floor(nc.length / 2)], nodeMax: nc[nc.length - 1],
      callsA: (window.__vantageIface || {}).callsA, skipped: (window.__vantageIface || {}).skipped });
  };
  window.__probe = br; return 'installed';
})()
