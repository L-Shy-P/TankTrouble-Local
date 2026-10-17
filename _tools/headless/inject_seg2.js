(function () {
  window.__s = {
    n: 0, aSamples: 0, lastCommits: null, skipHist: {},
    step: function () {
      try {
        var t = VantageTree.getTree();
        var st = (t && t.stats) || {};
        var c = st.commits;
        if (c !== undefined && c !== null) {
          if (window.__s.lastCommits !== null && c !== window.__s.lastCommits) window.__s.aSamples++;
          window.__s.lastCommits = c;
        }
        var g = window.__vantageIface || {};
        var k = String(g.skipped || 'none');
        window.__s.skipHist[k] = (window.__s.skipHist[k] || 0) + 1;
        window.__s.n++;
      } catch (e) { }
      return 1;
    },
    stat: function () {
      var t = VantageTree.getTree();
      var st = (t && t.stats) || {};
      return JSON.stringify({ frames: window.__s.n, commits: st.commits, aSamples: window.__s.aSamples, skipHist: window.__s.skipHist, tickSkippedFull: (window.__vantageIface || {}).tickSkippedFull });
    }
  };
  return 'installed';
})()
