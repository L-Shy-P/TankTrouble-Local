(() => {
  const ph = GameManager.getGame();
  const out = { at: ph.state.current };
  const safe = (label, fn) => { try { return fn(); } catch (e) { out['err_' + label] = String((e && e.message) || e); return undefined; } };

  try {
    Constants.setMode(Constants.MODE_CLIENT_LOCAL);

    const ttGame = GameController.create(
      BootCampGameMode.create(), false, false, false,
      Constants.CLIENT.MAX_PLAYERS,
      Constants.GAME_MODE_INFO[Constants.GAME_MODES.BOOT_CAMP].DEFAULT_AVAILABLE_CRATES,
      false, Constants.MAZE_THEMES.RANDOM
    );
    out.created = true;
    out.gameId = safe('gameId', () => ttGame.getId());
    out.playersAtCreate = safe('pAC', () => ttGame.getPlayerStates().length);

    // 我方坦克
    ttGame.addPlayer('tank_a');
    out.playersAfterA = safe('pAA', () => ttGame.getPlayerStates().length);

    // 对手：Laika
    if (AIs.isReady()) {
      const aiId = AIs.getAvailableAIId(ttGame.getId());
      out.aiId = aiId;
      if (aiId) {
        AIs.addAIManager(ttGame, aiId);
        ttGame.addPlayer(aiId);
      }
    }
    out.playersFinal = safe('pF', () => ttGame.getPlayerStates().length);
    out.playerIds = safe('pIds', () => ttGame.getPlayerStates().map((p) => p.getPlayerId()));

    GameManager.setGameController(ttGame);
    ph.state.start('Game', true, false, ttGame);
    out.started = true;
  } catch (e) {
    out.fatalErr = String((e && e.stack) || e).slice(0, 800);
  }

  window.__vtStep(40);
  out.stateAfter = ph.state.current;
  out.vtErrors = window.__vt.errors.slice(0, 5);
  out.gameControllerSet = !!GameManager.getGameController();
  return out;
})()
