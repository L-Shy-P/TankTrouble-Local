(function () {
  var br = {};
  window.__z = { n: 0, log: [], injectMem: true };
  br.mk = function (tag) {
    return { name: 'nnbridge' + tag, isReady: function () { return true; },
      decide: function (ctx) {
        try {
          var m = JSON.stringify((ctx && ctx.memory) || null);
          window.__z.log.push({ f: window.__z.n, tag: tag, mem: m.slice(0, 50) });
          if (window.__z.log.length > 40) window.__z.log.shift();
        } catch (e) { }
        return (tag === 'B' ? window.__z.bundleB : window.__z.bundleA) || null;
      } };
  };
  br.setup = function () {
    var A = VantageTreeInterface.Agents;
    A.register(br.mk('A'), 'A'); A.register(br.mk('B'), 'B');
    A.use('nnbridgeA', 'A'); A.use('nnbridgeB', 'B');
    return 'ok';
  };
  br.step = function (k) {
    window.__z.n = k;
    if (k === 3200) window.__z.injectMem = false;   // 停止注入 memory（此后若还看到 R1 就是残留）
    var t = VantageTree.getTree();
    var r = VantageTree.collectAgentNodes(t);
    var a = Array.isArray(r) ? r : [];
    var grow = null, deep = null;
    for (var i = 0; i < a.length; i++) {
      var o = a[i]; if (!o) continue;
      if (grow === null && o.hasGrown === false && !o.invalid && !o.exhausted) grow = o.id;
      if (deep === null && o.depth >= 1 && !o.invalid && !o.exhausted) deep = o.id;
    }
    var mem = window.__z.injectMem ? { nntag: 'R1', step: k } : null;
    window.__z.bundleA = (grow === null) ? null : (mem ? { picks: [{ nodeId: grow, back: 0 }], memory: mem } : { picks: [{ nodeId: grow, back: 0 }] });
    window.__z.bundleB = (deep === null) ? null : (mem ? { picks: [{ nodeId: deep, back: 0 }], memory: mem } : { picks: [{ nodeId: deep, back: 0 }] });
    return 1;
  };
  br.logAfter = function (from) {
    return JSON.stringify(window.__z.log.filter(function (e) { return e.f >= from; }));
  };
  window.__probe = br;
  return 'installed';
})()
