(function () {
  var br = {};
  br.mk = function (tag) {
    return {
      name: 'nnbridge' + tag,
      isReady: function () { return true; },
      decide: function (ctx) {
        try {
          window.__ctxLog.push({ tag: tag, mem: JSON.stringify((ctx && ctx.memory) || null).slice(0, 80), step: window.__step });
          if (window.__ctxLog.length > 8) window.__ctxLog.shift();
        } catch (e) { }
        return (tag === 'B' ? window.__nnBundleB : window.__nnBundleA) || null;
      }
    };
  };
  br.setup = function () {
    var A = VantageTreeInterface.Agents;
    A.register(br.mk('A'), 'A'); A.register(br.mk('B'), 'B');
    A.use('nnbridgeA', 'A'); A.use('nnbridgeB', 'B');
    window.__ctxLog = []; window.__step = 0;
    return 'ok';
  };
  br.frame = function (k) {
    window.__step = k;
    var t = VantageTree.getTree();
    var r = VantageTree.collectAgentNodes(t);
    var a = Array.isArray(r) ? r : [];
    var grow = null, deep = null;
    for (var i = 0; i < a.length; i++) {
      var o = a[i]; if (!o) continue;
      if (grow === null && o.hasGrown === false && !o.invalid && !o.exhausted) grow = o.id;
      if (deep === null && o.depth >= 1 && !o.invalid && !o.exhausted) deep = o.id;
    }
    window.__nnBundleA = (grow === null) ? null : { picks: [{ nodeId: grow, back: 0 }], memory: { nntag: 'RT', step: k } };
    window.__nnBundleB = (deep === null) ? null : { picks: [{ nodeId: deep, back: 0 }], memory: { nntag: 'RT', step: k } };
    return 1;
  };
  br.log = function () { return JSON.stringify(window.__ctxLog || []); };
  window.__probe = br;
  return 'installed';
})()
