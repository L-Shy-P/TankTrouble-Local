(() => {
  const ph = GameManager.getGame();
  const out = {};
  const gc = GameManager.getGameController();
  out.hasGC = !!gc;
  if (!gc) return out;

  const methods = (o) => Object.getOwnPropertyNames(Object.getPrototypeOf(o)).filter((k) => k !== 'constructor');
  out.gcMethods = methods(gc);

  const rc = gc.getRoundController ? gc.getRoundController() : null;
  out.hasRC = !!rc;
  if (rc) {
    out.rcMethods = methods(rc);
    // 找出坦克
    const tankIds = [];
    if (rc.getTanks) {
      try { const ts = rc.getTanks(); out.tanksType = Object.prototype.toString.call(ts); } catch (e) { out.tanksErr = String(e); }
    }
    // 常见命名都试一遍
    for (const name of ['getTankIds', 'getPlayerIds', 'getTankCount', 'getTank', 'getTanks']) {
      out['has_' + name] = typeof rc[name];
    }
  }
  for (const name of ['getPlayerIds', 'getPlayerStates', 'getTankIds', 'getTanks', 'getId', 'getRoundController', 'getGameMode']) {
    out['gc_has_' + name] = typeof gc[name];
  }
  out.state = ph.state.current;
  out.players = (() => { try { return gc.getPlayerIds(); } catch (e) { return 'ERR'; } })();
  return out;
})()
