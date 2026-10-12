'use strict';
const { Match } = require('./match');
(async () => {
  const m = new Match();
  await m.open({ humanIds: ['tank_a'], aiCount: 0, vantCount: 1, rng: 'record' });
  const info = await m.eval(`(() => {
    var out = {};
    out.tGC = typeof GameController; out.tRM = typeof RoundModel;
    try { out.gcProtoUpd = typeof GameController.prototype.update; } catch (e) { out.gcProtoErr = String(e); }
    try { out.rmProtoUpd = typeof RoundModel.prototype.update; } catch (e) { out.rmProtoErr = String(e); }
    var gc = GameManager.getGameController();
    out.gcOwnUpd = typeof gc.update;
    out.gcProtoSame = (gc.update === (GameController.prototype && GameController.prototype.update));
    var rm = gc.roundController && gc.roundController.model;
    out.rmOwnUpd = rm ? typeof rm.update : null;
    out.rmProtoSame = (rm && rm.update === (RoundModel.prototype && RoundModel.prototype.update));
    out.state = gc.getState(); out.running = rm ? rm.running : null;
    var d = VantageTree.dumpDiagnostics();
    out.tree = !!d; out.ver = VantageTree.VERSION;
    out.pnow = (typeof performance !== 'undefined' && performance.now) ? performance.now() : null;
    out.dnow = Date.now();
    var lu = gc.lastUpdate; out.luType = typeof lu; out.luMs = (lu && lu.getTime) ? lu.getTime() : null;
    out.keys = Object.keys(gc).filter(function(k){return /update|last/i.test(k);});
    return out;
  })()`);
  console.log(JSON.stringify(info, null, 1));
  await m.close();
})().catch((e) => { console.error(String(e && e.stack || e)); process.exitCode = 1; });
