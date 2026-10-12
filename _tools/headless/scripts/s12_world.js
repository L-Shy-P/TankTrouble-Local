(async () => {
  const ph = GameManager.getGame();
  const gc = GameManager.getGameController();
  const out = {};

  const tanks = () => {
    try {
      return gc.getTanks().map((t) => {
        const o = {};
        try { o.id = t.getPlayerId(); } catch (e) { o.id = '?'; }
        try { o.x = +t.getX().toFixed(2); o.y = +t.getY().toFixed(2); } catch (e) {}
        try { o.rot = +t.getRotation().toFixed(3); } catch (e) {}
        try { o.alive = t.isAlive ? t.isAlive() : t.alive; } catch (e) {}
        try { o.vel = typeof t.getVelocity === 'function' ? +t.getVelocity().length().toFixed(2) : undefined; } catch (e) {}
        return o;
      });
    } catch (e) { return 'ERR ' + e; }
  };
  const projs = () => { try { return gc.getProjectiles().length; } catch (e) { return 'ERR'; } };

  out.roundState = (() => { try { return gc.getRoundState(); } catch (e) { return 'ERR'; } })();
  out.activePlayers = (() => { try { return gc.getActivePlayerIds(); } catch (e) { return 'ERR'; } })();
  out.allPlayers = (() => { try { return gc.getAllPlayerIds(); } catch (e) { return 'ERR'; } })();
  out.stage = ph.state.current;
  out.t0 = tanks();
  out.p0 = projs();

  // 交错泵帧 180 帧（每帧让出 6ms 真实时间）
  for (let i = 0; i < 180; i++) {
    window.__vtStep(1);
    await new Promise((r) => setTimeout(r, 6));
  }

  out.t180 = tanks();
  out.p180 = projs();
  out.roundState180 = (() => { try { return gc.getRoundState(); } catch (e) { return 'ERR'; } })();
  out.stage180 = ph.state.current;
  out.virtualT = window.__vt.t;
  out.vtErrors = window.__vt.errors.slice(0, 4);

  // 弹丸细节
  try {
    const ps = gc.getProjectiles();
    out.projectileSample = ps.slice(0, 3).map((p) => {
      const o = {};
      try { o.x = +p.getX().toFixed(2); o.y = +p.getY().toFixed(2); } catch (e) {}
      try { o.rot = +p.getRotation().toFixed(3); } catch (e) {}
      try { o.owner = p.getOwnerPlayerId ? p.getOwnerPlayerId() : (p.getPlayerId ? p.getPlayerId() : '?'); } catch (e) {}
      return o;
    });
  } catch (e) { out.projErr = String(e); }

  // 坦克上的可用方法，方便下一步写接口
  try {
    const t0 = gc.getTanks()[0];
    out.tankMethods = Object.getOwnPropertyNames(Object.getPrototypeOf(t0)).filter((k) => k !== 'constructor');
  } catch (e) {}
  return out;
})()
