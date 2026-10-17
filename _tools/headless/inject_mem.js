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
    return 'ok';
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
  br.ident = function () {
    var o = {};
    var t1 = VantageTree.getTree();
    var t2 = VantageTree.getTree();
    o.sameTwice = (t1 === t2);
    o.t1Keys = Object.keys(t1).length;
    o.hasMemSlots = Object.keys(t1).filter(function (k) { return /memory|_agentMemory/i.test(k); });
    try {
      var d = JSON.stringify(VantageTree.dumpDiagnostics(t1));
      o.diagLen = d.length;
      var i = d.indexOf('nntag');
      o.diagHasNntag = (i >= 0);
      if (i >= 0) o.diagSnippet = d.slice(Math.max(0, i - 60), i + 60);
    } catch (e) { o.diagErr = String(e.message || e).slice(0, 60); }
    o.memShared = JSON.stringify(t1._agentMemory || null).slice(0, 60);
    o.memA = JSON.stringify(t1._agentMemoryA || null).slice(0, 60);
    return JSON.stringify(o);
  };
  window.__probe = br;
  return 'installed';
})()
