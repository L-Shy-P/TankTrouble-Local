(function () {
  window.__r3 = { n: 0, s: {}, ch: {}, deaths0: null, log: [] };
  window.__r3.step = function (k) {
    try {
      var gc = GameManager.getGameController();
      var m = gc.roundController && gc.roundController.model;
      if (m) {
        var f = ['started', 'running'];
        for (var i = 0; i < f.length; i++) {
          var v = String(m[f[i]]);
          if (window.__r3.s[f[i]] === undefined) window.__r3.s[f[i]] = v;
          else if (window.__r3.s[f[i]] !== v) { window.__r3.ch[f[i]] = (window.__r3.ch[f[i]] || 0) + 1; window.__r3.log.push(k + ':' + f[i] + '=' + v); window.__r3.s[f[i]] = v; }
        }
      }
      var ad = VantageSandbox.createAdapter(gc, 'tank_a');
      var d = (typeof ad.getDeathsCount === 'function') ? ad.getDeathsCount() : -1;
      if (window.__r3.deaths0 === null) window.__r3.deaths0 = d;
      window.__r3.deathsNow = d;
    } catch (e) { window.__r3.err = String(e.message || e).slice(0, 40); }
    window.__r3.n++;
    return 1;
  };
  window.__r3.stat = function () {
    return JSON.stringify({ n: window.__r3.n, sig: window.__r3.s, changes: window.__r3.ch, log: window.__r3.log.slice(0, 8), deaths: window.__r3.deathsNow, deaths0: window.__r3.deaths0, err: window.__r3.err });
  };
  return 'installed';
})()
