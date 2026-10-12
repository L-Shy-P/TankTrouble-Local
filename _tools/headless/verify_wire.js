const { Match } = require('./match');
(async () => {
  const t0 = Date.now();
  const m = new Match();
  const T = (l) => ((Date.now() - t0) / 1000).toFixed(1) + 's';
  try {
    await m.open({ humanIds: ['tank_a'], aiCount: 0, vantCount: 1 });
    console.log(`[${T()}] 开局完成 bootstrap=${JSON.stringify(m.bootstrap)}`);

    await m.pump(300, { yieldMs: 0 });
    console.log(`[${T()}] 跑了 300 帧`);

    const r = await m.eval(`(() => {
      var s = window.__vantageIface || {};
      return { tickCalls: s.tickCalls, tickOk: s.tickOk, tickErr: s.tickErr,
               calls: s.calls, skipped: s.skipped,
               lastCtxNodes: s.lastCtx && s.lastCtx.nodes ? s.lastCtx.nodes.length : null,
               hasVantageTree: typeof VantageTree, hasVantageAI: typeof VantageAI };
    })()`);
    const s = await m.snapshot();
    console.log(JSON.stringify({
      用时: T(),
      stage: s.stage,
      玩家: s.players,
      坦克: s.tanks.map((x) => `${x.id}@(${x.x.toFixed(0)},${x.y.toFixed(0)})`),
      接口: r,
      vtErrors: (await m.stats()).errors.slice(0, 3),
    }, null, 1));
  } catch (e) { console.error('FAILED:', (e && e.stack) || e); process.exitCode = 1; }
  finally { await m.close(); }
})();
