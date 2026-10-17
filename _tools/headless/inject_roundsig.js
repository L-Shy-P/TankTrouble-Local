(function () {
  window.__rs = { n: 0, s1: null, s2: null, s3: null, ch1: [], ch2: [], ch3: [] };
  window.__rs.step = function (k) {
    var out = {};
    try {
      var t = VantageTree.getTree();
      var st = (t && t.stats) || {};
      var v1 = String(st.freshRoots) + '/' + String(st.rebuilds);
      if (window.__rs.s1 === null) window.__rs.s1 = v1;
      else if (v1 !== window.__rs.s1) { window.__rs.ch1.push(k + ':' + v1); window.__rs.s1 = v1; }
      out.s1 = v1;
    } catch (e) { out.e1 = 1; }
    try {
      var gc = GameManager.getGameController();
      var m = gc.roundController && gc.roundController.model ? gc.roundController.model : null;
      var v2 = m ? String(m._state) : 'no-model';
      if (window.__rs.s2 === null) window.__rs.s2 = v2;
      else if (v2 !== window.__rs.s2) { window.__rs.ch2.push(k + ':' + v2); window.__rs.s2 = v2; }
      out.s2 = v2;
    } catch (e) { out.e2 = 1; }
    try {
      var g = window.__vantageIface || {};
      var v3 = String(g.tickCalls) + '/' + String(g.tickOk);
      if (window.__rs.s3 === null) window.__rs.s3 = v3;
      else if (v3 !== window.__rs.s3) { window.__rs.ch3.push(k + ':' + v3); window.__rs.s3 = v3; }
      out.s3 = v3;
    } catch (e) { out.e3 = 1; }
    window.__rs.n++;
    return JSON.stringify(out);
  };
  window.__rs.stat = function () {
    return JSON.stringify({ n: window.__rs.n, s1: window.__rs.s1, s2: window.__rs.s2, s3: window.__rs.s3,
      ch1: window.__rs.ch1.slice(0, 6), ch2: window.__rs.ch2.slice(0, 6), ch3: window.__rs.ch3.slice(0, 6),
      n1: window.__rs.ch1.length, n2: window.__rs.ch2.length, n3: window.__rs.ch3.length });
  };
  return 'installed';
})()
