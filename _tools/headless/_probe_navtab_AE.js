'use strict';
/* \u5bfc\u822a\u8868 A\uff08\u6362\u56fe\u5373\u5efa\uff09+ E\uff08\u9884\u7b97\u9600\uff09\u9a8c\u6536\uff08v2\uff0c\u4fee\u6389\u5355\u4f4d bug \u540e\uff09
 *   node _tools/headless/_probe_navtab_AE.js
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Match } = require('./match');
const P = (s) => console.log(s);

(async () => {
  const out = { fps: [] };
  for (const rel of ['game_core/js/vantage_sandbox.js', 'game_core/js/vantage_tree.js', 'game_core/index.html']) {
    const p = path.join(__dirname, '..', '..', rel);
    const st = fs.statSync(p);
    out.fps.push({ file: rel, mtime: st.mtime.toISOString(), bytes: st.size,
      md5: crypto.createHash('md5').update(fs.readFileSync(p)).digest('hex') });
  }
  for (const f of out.fps) P('  ' + f.file + '  ' + f.mtime + '  ' + f.md5 + '  ' + f.bytes);

  const m = new Match();
  try {
    await m.open({ humanIds: ['tank_a'], aiCount: 1, vantCount: 2, bootFrames: 300, rebaseAtMenu: true });
    P('  open ok; TREE=' + await m.eval('VantageTree.VERSION'));
    // console.error \u62e6\u622a\uff08\u8bc1\u660e E \u7684\u544a\u8b66**\u771f\u7684\u53d1\u51fa**\uff09
    await m.eval(`(() => { window.__navErrors = []; var oe = console.error;
      console.error = function () { try { window.__navErrors.push(Array.prototype.slice.call(arguments).join(' ')); } catch (e) {} return oe.apply(console, arguments); };
      return 1; })()`);
    // A\uff1a\u7b49\u8868\u88ab\u5efa\uff08\u5237\u5230 state!=idle\uff0c\u4e0a\u9650 200 \u5e27\uff09
    let f = 0, st = null, vtAtBuild = null;
    for (; f < 200; f++) {
      await m.pump(1);
      st = await m.eval('VantageSandbox.getNavTableStatus()');
      if (st.state !== 'idle') { vtAtBuild = await m.eval('window.__vt.t'); break; }
    }
    P('  [A] \u5efa\u8868\u53d1\u751f\u5728\u7b2c ' + (f + 1) + ' \u5e27\uff1a' + JSON.stringify(st) + '  vt=' + vtAtBuild);
    // \u518d\u8dd1\u5230 150 \u5e27\u540e\u79cd\u4e00\u53d1\u5bfc\u5f39\uff08\u8bc1\u660e\u8868\u8fdc\u65e9\u4e8e\u5bfc\u5f39\uff09
    while (f < 150) { await m.pump(5); f += 5; }
    const inj = await m.eval(`(() => {
      var gc = GameManager.getGameController();
      var t = gc.getTank('tank_a');
      var ps = ProjectileState.withState('probe_ae_missile', 'tank_a', 3, t.getX() + 5, t.getY() + 5, 18, 0);
      gc.roundController.setProjectileState(ps);
      var p = gc.getProjectile('probe_ae_missile');
      return { ok: !!p, tgt: p ? p.currentTargetPlayerId : null, vt: window.__vt.t };
    })()`);
    P('  [A] \u7b2c\u4e00\u53d1\u5bfc\u5f39\u51fa\u73b0\u4e8e vt=' + inj.vt + '  (\u5efa\u8868 vt=' + vtAtBuild + ')  ' + JSON.stringify(inj));
    out.A = { builtAtFrame: f + 1, status: st, vtAtBuild: vtAtBuild, missileVt: inj.vt, lagMs: inj.vt - vtAtBuild };
    // E\uff1amonkeypatch getMaze \u2192 \u771f 20x12 \u8ff7\u5bab\uff08\u4ece\u4ea7\u54c1\u5165\u53e3\u8fdb\u53bb\uff09
    const eT0 = process.hrtime.bigint();
    await m.eval(`(() => {
      var gc = GameManager.getGameController();
      var big = Maze.createRandom(20, 12, ['tank_a','vantage_1'], 0);
      window.__navBigMaze = big;
      var orig = gc.getMaze;
      gc.getMaze = function () { return big; };
      window.__navRestoreMaze = function () { gc.getMaze = orig; };
      return 1;
    })()`);
    await m.pump(10);
    const stE = await m.eval('VantageSandbox.getNavTableStatus()');
    const errs = await m.eval('window.__navErrors.slice(0, 3)');
    const eT1 = process.hrtime.bigint();
    P('  [E] \u5927\u8ff7\u5bab\uff0820x12\uff09\u540e\u72b6\u6001 = ' + JSON.stringify(stE));
    P('  [E] console.error \u62e6\u622a = ' + JSON.stringify(errs));
    P('  [E] \u8282\u70b9\u5899\u949f\uff08\u542b 10 \u5e27\u6cf5\u5e27\uff09= ' + (Number(eT1 - eT0) / 1e6).toFixed(1) + ' ms');
    out.E = { status: stE, consoleErrors: errs, wallMs: Number(eT1 - eT0) / 1e6 };
    // \u6062\u590d\u771f\u5b9e\u8ff7\u5bab + \u518d\u770b\u4e00\u773c\uff08\u8bf4\u660e\u72b6\u6001\u4f4d\u662f"\u6700\u8fd1\u4e00\u6b21\u52a8\u4f5c"\uff09
    await m.eval('window.__navRestoreMaze()');
    const stR = await m.eval('VantageSandbox.getNavTableStatus()');
    P('  [\u6062\u590d] \u771f\u5b9e\u8ff7\u5bab\u72b6\u6001\uff08\u672a\u518d\u8dd1\uff09= ' + JSON.stringify(stR));
    out.restored = stR;
    P('  pageErrors: ' + JSON.stringify(m.pageErrors.slice(0, 3)));
  } catch (e) {
    out.err = String((e && e.stack) || e); P('FATAL: ' + out.err); process.exitCode = 1;
  } finally {
    fs.writeFileSync(path.join(__dirname, 'prof', 'probe_navtab_AE.json'), JSON.stringify(out, null, 1));
    try { await m.close(); } catch (e) {}
    P('[done]');
  }
})();
