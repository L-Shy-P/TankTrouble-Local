(() => {
  const out = {};
  const G = (typeof GameManager !== 'undefined') ? GameManager : null;
  out.hasGameManager = !!G;
  let ph = null;
  try { ph = G && (G.getGame ? G.getGame() : null); } catch (e) {}
  if (!ph && G && G.phaserInstance) ph = G.phaserInstance;
  out.hasPhaserInstance = !!ph;
  if (ph && ph.state) {
    out.stateCurrent = ph.state.current;
    const st = ph.state.getCurrentState();
    out.stateObjName = st ? (st.constructor && st.constructor.name || Object.keys(st).slice(0, 5).join(',')) : null;
    out.hasLocalGameButton = !!(st && st.localGameButton);
    out.lobbyKeys = st ? Object.keys(st).slice(0, 40) : null;
  }
  // 状态机里注册了哪些 state
  try {
    const sm = ph && ph.state;
    out.states = sm && sm.states ? Object.keys(sm.states) : null;
  } catch (e) { out.statesErr = String(e); }

  out.hasAIs = typeof AIs;
  try { out.aisReady = AIs.isReady(); } catch (e) { out.aisReadyErr = String(e); }
  try { out.aiIds = AIs.getAvailableAIId ? [AIs.getAvailableAIId('probe')] : null; } catch (e) { out.aiIdErr = String(e); }

  try { out.users = Users.getAllPlayerIds(); } catch (e) { out.usersErr = String(e); }
  try { out.mode = Constants.getMode ? Constants.getMode() : null; } catch (e) {}
  out.clientState = (() => { try { return ClientManager.getClient().getState(); } catch (e) { return 'ERR:' + e; } })();
  out.browserStamp = Date.now();
  return out;
})()
