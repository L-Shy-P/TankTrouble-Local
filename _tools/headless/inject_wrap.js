(function () {
  var br = {};
  br.mk = function (tag) {
    return { name: 'nnbridge' + tag, isReady: function () { return true; },
      decide: function () { return (tag === 'B' ? window.__nnBundleB : window.__nnBundleA) || null; } };
  };
  br.setup = function () {
    var A = VantageTreeInterface.Agents;
    A.register(br.mk('A'), 'A'); A.register(br.mk('B'), 'B');
    A.use('nnbridgeA', 'A'); A.use('nnbridgeB', 'B');
    window.__wrapLog = [];
    window.__origVD = VantageTreeInterface.validateDecision;
    VantageTreeInterface.validateDecision = function (d) {
      var out = window.__origVD.apply(this, arguments);
      try {
        window.__wrapLog.push({ hasMem: !!(out && out.memory), mem: (out && out.memory) ? JSON.stringify(out.memory).slice(0, 40) : null });
        if (window.__wrapLog.length > 6) window.__wrapLog.shift();
      } catch (e) { }
      return out;
    };
    return 'ok';
  };
  br.restore = function () {
    if (window.__origVD) VantageTreeInterface.validateDecision = window.__origVD;
    return 'restored';
  };
  br.frame = function (k) {
    var t = VantageTree.getTree();
    var r = VantageTree.collectAgentNodes(t);
    var a = Array.isArray(r) ? r : [];
    var grow = null, deep = null;
    for (var i = 0; i < a.length; i++) {
      var o = a[i];
      if (!o) continue;
      if (grow === null && o.hasGrown === false && !o.invalid && !o.exhausted) grow = o.id;
      if (deep === null && o.depth >= 1 && !o.invalid && !o.exhausted) deep = o.id;
    }
    window.__nnBundleA = (grow === null) ? null : { picks: [{ nodeId: grow, back: 0 }], memory: { nntag: 'MM', step: k } };
    window.__nnBundleB = (deep === null) ? null : { picks: [{ nodeId: deep, back: 0 }], memory: { nntag: 'MM', step: k } };
    return 1;
  };
  br.log = function () { return JSON.stringify(window.__wrapLog || []); };
  window.__probe = br;
  return 'installed';
})()
