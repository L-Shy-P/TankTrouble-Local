(function () {
  window.__p = { n: 0, ev: [], evNames: null, info: {} };
  window.__p.setup = function () {
    try {
      var gc = GameManager.getGameController();
      window.__p.info.mode = String((typeof Constants !== 'undefined' && Constants.getMode) ? Constants.getMode() : 'n/a');
      try { window.__p.info.modeName = String(gc.getMode ? gc.getMode() : 'n/a'); } catch (e) { }
      try { window.__p.info.totalPlayers = String(gc.getTotalPlayerCount ? gc.getTotalPlayerCount() : 'no-api'); } catch (e) { window.__p.info.totalPlayers = 'err'; }
      try {
        if (typeof Constants !== 'undefined' && Constants.GAME_MODE_INFO && gc.getMode) {
          var mi = Constants.GAME_MODE_INFO[gc.getMode()];
          window.__p.info.minPlayers = mi ? String(mi.MIN_PLAYERS) : 'no-info';
          window.__p.info.keys = mi ? Object.keys(mi).slice(0, 12) : null;
        }
      } catch (e) { window.__p.info.minPlayers = 'err'; }
      try { window.__p.info.tanks = String(Object.keys(gc.getTanks() || {}).length); } catch (e) { }
      try { window.__p.info.playerIds = String((gc.getPlayerIds && gc.getPlayerIds()) || 'no-api'); } catch (e) { }
      try {
        window.__p.evNames = (typeof RoundModel !== 'undefined' && RoundModel._EVENTS) ? Object.keys(RoundModel._EVENTS).filter(function (k) { return /ROUND|CELEBRATION/i.test(k); }) : ['no-RoundModel'];
        gc.addRoundEventListener(function (self, id, evt, data) {
          try { window.__p.ev.push({ f: window.__p.n, evt: String(evt) }); } catch (e) { }
        }, window.__p);
      } catch (e) { window.__p.info.subErr = String(e.message || e).slice(0, 60); }
    } catch (e) { window.__p.info.err = String(e.message || e).slice(0, 60); }
    return JSON.stringify(window.__p.info);
  };
  window.__p.step = function (k) {
    window.__p.n = k;
    try {
      var gc = GameManager.getGameController();
      var m = gc.roundController && gc.roundController.model;
      if (m) { window.__p.started = String(m.started); window.__p.running = String(m.running); }
      var ad = VantageSandbox.createAdapter(gc, 'tank_a');
      if (typeof ad.getDeathsCount === 'function') window.__p.deaths = ad.getDeathsCount();
      window.__p.totalPlayersNow = String(gc.getTotalPlayerCount ? gc.getTotalPlayerCount() : 'n/a');
    } catch (e) { }
    return 1;
  };
  window.__p.stat = function () {
    return JSON.stringify({ n: window.__p.n, info: window.__p.info, evNames: window.__p.evNames, events: window.__p.ev.slice(0, 10),
      nEvents: window.__p.ev.length, started: window.__p.started, running: window.__p.running, deaths: window.__p.deaths, totalPlayersNow: window.__p.totalPlayersNow });
  };
  window.__probe = window.__p;
  return 'installed';
})()
