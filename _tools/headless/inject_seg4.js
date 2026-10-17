(function () {
  window.__s4 = {
    n: 0, lastCommits: null, segChanges: 0, aSamples: 0, N: 4,
    step: function () {
      try {
        var t = VantageTree.getTree();
        var st = (t && t.stats) || {};
        var c = st.commits;
        if (c !== undefined && c !== null) {
          if (window.__s4.lastCommits !== null && c !== window.__s4.lastCommits) {
            window.__s4.segChanges++;
            if (window.__s4.segChanges % window.__s4.N === 0) window.__s4.aSamples++;
          }
          window.__s4.lastCommits = c;
        }
        window.__s4.n++;
      } catch (e) { }
      return 1;
    },
    stat: function () {
      var t = VantageTree.getTree();
      var st = (t && t.stats) || {};
      var perSampleBytes = 84 * 1024;
      var rounds = 1200 / window.__s4.n;
      return JSON.stringify({
        frames: window.__s4.n, commits: st.commits, segChanges: window.__s4.segChanges,
        aSamples: window.__s4.aSamples, N: window.__s4.N,
        perRoundSamples: Math.round(window.__s4.aSamples * rounds),
        perRoundMB: +(window.__s4.aSamples * rounds * perSampleBytes / 1e6).toFixed(2),
        games17GB: Math.floor(17e9 / (window.__s4.aSamples * rounds * perSampleBytes))
      });
    }
  };
  return 'installed';
})()
