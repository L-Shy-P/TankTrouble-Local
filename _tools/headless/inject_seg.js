(function () {
  window.__seg = {
    aCount: 0, lastCommits: -1, skips: 0,
    step: function () {
      var t = VantageTree.getTree();
      var st = (t && t.stats) || {};
      var c = st.commits || 0;
      if (c !== window.__seg.lastCommits) {
        window.__seg.lastCommits = c;
        window.__seg.aCount++;
      }
      return c;
    },
    stat: function () {
      var t = VantageTree.getTree();
      var st = (t && t.stats) || {};
      return JSON.stringify({ commits: st.commits || 0, aSamples: window.__seg.aCount, expands: st.expands || 0, calls: (window.__vantageIface || {}).tickCalls });
    }
  };
  return 'installed';
})()
