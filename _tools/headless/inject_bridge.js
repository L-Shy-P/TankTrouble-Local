(function () {
  var br = {};
  br.mk = function (tag) {
    return {
      name: 'nnbridge' + tag,
      isReady: function () { return true; },
      decide: function () { return (tag === 'B' ? window.__nnBundleB : window.__nnBundleA) || null; }
    };
  };
  br.setup = function () {
    var A = VantageTreeInterface.Agents;
    A.register(br.mk('A'), 'A');
    A.register(br.mk('B'), 'B');
    A.use('nnbridgeA', 'A');
    A.use('nnbridgeB', 'B');
    return JSON.stringify({ a: String((A.current('A') || {}).name), b: String((A.current('B') || {}).name) });
  };
  br.frame = function (k) {
    try {
      var t = VantageTree.getTree();
      var r = VantageTree.collectAgentNodes(t);
      var a = Array.isArray(r) ? r : [];
      var grow = null;
      var deep = null;
      for (var i = 0; i < a.length; i++) {
        var o = a[i];
        if (!o) continue;
        if (grow === null && o.hasGrown === false && !o.invalid && !o.exhausted) grow = o.id;
        if (deep === null && o.depth >= 1 && !o.invalid && !o.exhausted) deep = o.id;
      }
      window.__nnBundleA = (grow === null) ? null : { picks: [{ nodeId: grow, back: 0 }], memory: { nntag: 'M1', step: k } };
      window.__nnBundleB = (deep === null) ? null : { picks: [{ nodeId: deep, back: 0 }], memory: { nntag: 'B1', step: k } };
      window.__lastInj = { grow: grow, deep: deep, hasMemA: !!(window.__nnBundleA && window.__nnBundleA.memory), hasMemB: !!(window.__nnBundleB && window.__nnBundleB.memory) };
      return JSON.stringify({ grow: grow, deep: deep });
    } catch (e) { return 'err'; }
  };
  br.stat = function () {
    var g = window.__vantageIface || {};
    var t = VantageTree.getTree();
    return JSON.stringify({
      callsA: g.callsA, callsB: g.callsB, picks: g.picks, giveUpA: g.giveUpA, giveUpB: g.giveUpB, skipped: g.skipped,
      memShared: JSON.stringify(t._agentMemory || null).slice(0, 90),
      memA: JSON.stringify(t._agentMemoryA || null).slice(0, 90),
      memB: JSON.stringify(t._agentMemoryB || null).slice(0, 90)
    });
  };
  window.__probe = br;
  return 'installed';
})()
