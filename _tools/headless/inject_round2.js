(function () {
  window.__q = { n: 0, keys: null, modelKeys: null, vals: {}, ch: {} };
  window.__q.step = function (k) {
    if (window.__q.keys === null) {
      try {
        var t = VantageTree.getTree();
        var st = (t && t.stats) || {};
        window.__q.keys = Object.keys(st).slice(0, 30);
      } catch (e) { window.__q.keys = ['err']; }
      try {
        var gc = GameManager.getGameController();
        var m = gc.roundController && gc.roundController.model;
        window.__q.modelKeys = m ? Object.keys(m).slice(0, 30) : ['no-model'];
      } catch (e) { window.__q.modelKeys = ['err']; }
    }
    try {
      var gc = GameManager.getGameController();
      var m = gc.roundController && gc.roundController.model;
      if (m) {
        var cand = ['_state', 'state', '_roundNumber', 'roundNumber', 'currentRound', '_roundIndex'];
        for (var i = 0; i < cand.length; i++) {
          var f = cand[i];
          var v = String(m[f]);
          if (window.__q.vals[f] === undefined) window.__q.vals[f] = v;
          else if (window.__q.vals[f] !== v) { window.__q.ch[f] = (window.__q.ch[f] || 0) + 1; window.__q.vals[f] = v; }
        }
      }
      var ad = VantageSandbox.createAdapter(gc, 'tank_a');
      window.__q.deaths = (typeof ad.getDeathsCount === 'function') ? ad.getDeathsCount() : 'n/a';
      window.__q.dmap = (typeof ad.getLastRoundDeaths === 'function') ? String(ad.getLastRoundDeaths()) : 'n/a';
    } catch (e) { window.__q.err = String(e.message || e).slice(0, 40); }
    window.__q.n++;
    return 1;
  };
  window.__q.stat = function () {
    return JSON.stringify({ n: window.__q.n, statKeys: window.__q.keys, modelKeys: window.__q.modelKeys,
      vals: window.__q.vals, changes: window.__q.ch, deaths: window.__q.deaths, lastRoundDeaths: String(window.__q.dmap).slice(0, 60), err: window.__q.err });
  };
  return 'installed';
})()
