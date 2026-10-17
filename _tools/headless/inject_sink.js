(function () {
  window.__k = { n: 0, lastCommits: null, seg: 0, samples: [], injectEmpty: false, roundStartFrames: [], memLog: [] };
  window.__k.mk = function (tag) {
    return { name: 'nnbridge' + tag, isReady: function () { return true; },
      decide: function (ctx) {
        try {
          if (window.__k.memLog.length > 30) window.__k.memLog.shift();
          window.__k.memLog.push({ f: window.__k.n, tag: tag, mem: JSON.stringify((ctx && ctx.memory) || null).slice(0, 40) });
        } catch (e) { }
        return (tag === 'B' ? window.__k.bundleB : window.__k.bundleA) || null;
      } };
  };
  window.__k.setup = function () {
    var A = VantageTreeInterface.Agents;
    A.register(window.__k.mk('A'), 'A'); A.register(window.__k.mk('B'), 'B');
    A.use('nnbridgeA', 'A'); A.use('nnbridgeB', 'B');
    try {
      var gc = GameManager.getGameController();
      gc.addRoundEventListener(function (self, id, evt, data) {
        var s = String(evt);
        if (/round started/i.test(s)) { window.__k.injectEmpty = true; window.__k.roundStartFrames.push(window.__k.n); }
      }, window.__k);
    } catch (e) { }
    return 'ok';
  };
  window.__k.step = function (k) {
    window.__k.n = k;
    var t = VantageTree.getTree();
    var st = (t && t.stats) || {};
    var c = st.commits;
    if (c !== undefined && c !== null) {
      if (window.__k.lastCommits !== null && c !== window.__k.lastCommits) {
        window.__k.seg++;
        if (window.__k.seg % 4 === 0) {
          var r = VantageTree.collectAgentNodes(t);
          var arr = Array.isArray(r) ? r : [];
          window.__k.samples.push({ f: k, commits: c, nNodes: arr.length });
        }
      }
      window.__k.lastCommits = c;
    }
    var r2 = VantageTree.collectAgentNodes(t);
    var a = Array.isArray(r2) ? r2 : [];
    var grow = null, deep = null;
    for (var i = 0; i < a.length; i++) {
      var o = a[i]; if (!o) continue;
      if (grow === null && o.hasGrown === false && !o.invalid && !o.exhausted) grow = o.id;
      if (deep === null && o.depth >= 1 && !o.invalid && !o.exhausted) deep = o.id;
    }
    var mem = window.__k.injectEmpty ? {} : { nntag: 'R1', step: k };
    window.__k.bundleA = (grow === null) ? null : { picks: [{ nodeId: grow, back: 0 }], memory: mem };
    window.__k.bundleB = (deep === null) ? null : { picks: [{ nodeId: deep, back: 0 }], memory: mem };
    return 1;
  };
  window.__probe = window.__k;
  return 'installed';
})()
