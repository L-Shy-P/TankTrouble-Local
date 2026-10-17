(function () {
  var br = {};
  window.__r = { ctxLog: [], roundId: null, atFrame: 0, changes: [], memAtChange: [] };
  br.mk = function (tag) {
    return { name: 'nnbridge' + tag, isReady: function () { return true; },
      decide: function (ctx) {
        try {
          var m = JSON.stringify((ctx && ctx.memory) || null).slice(0, 60);
          if (window.__r.ctxLog.length > 6) window.__r.ctxLog.shift();
          window.__r.ctxLog.push({ tag: tag, mem: m });
        } catch (e) { }
        return (tag === 'B' ? window.__r.bundleB : window.__r.bundleA) || null;
      } };
  };
  br.setup = function () {
    var A = VantageTreeInterface.Agents;
    A.register(br.mk('A'), 'A'); A.register(br.mk('B'), 'B');
    A.use('nnbridgeA', 'A'); A.use('nnbridgeB', 'B');
    return 'ok';
  };
  br.roundIdNow = function () {
    try {
      var gc = GameManager.getGameController();
      var rs = gc.roundController ? gc.roundController.getRoundState(true) : null;
      return JSON.stringify(rs || null).slice(0, 40);
    } catch (e) { return 'err'; }
  };
  br.step = function (k) {
    window.__r.atFrame = k;
    var rid = br.roundIdNow();
    if (window.__r.roundId === null) window.__r.roundId = rid;
    else if (rid !== window.__r.roundId) {
      window.__r.changes.push(k);
      window.__r.memAtChange.push(JSON.stringify(window.__r.ctxLog.slice(-2)));
      window.__r.roundId = rid;
    }
    var t = VantageTree.getTree();
    var r = VantageTree.collectAgentNodes(t);
    var a = Array.isArray(r) ? r : [];
    var grow = null, deep = null;
    for (var i = 0; i < a.length; i++) {
      var o = a[i]; if (!o) continue;
      if (grow === null && o.hasGrown === false && !o.invalid && !o.exhausted) grow = o.id;
      if (deep === null && o.depth >= 1 && !o.invalid && !o.exhausted) deep = o.id;
    }
    var tagMem = { nntag: 'ROUND1', step: k };
    window.__r.bundleA = (grow === null) ? null : { picks: [{ nodeId: grow, back: 0 }], memory: tagMem };
    window.__r.bundleB = (deep === null) ? null : { picks: [{ nodeId: deep, back: 0 }], memory: tagMem };
    return 1;
  };
  br.stat = function () {
    return JSON.stringify({ atFrame: window.__r.atFrame, changes: window.__r.changes, memAtChange: window.__r.memAtChange, lastCtx: window.__r.ctxLog.slice(-2), roundId: window.__r.roundId });
  };
  window.__probe = br;
  return 'installed';
})()
