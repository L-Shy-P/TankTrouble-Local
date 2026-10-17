'use strict';
/* ============================================================================
 * S1-毒雾 自证探针（终版）：毒雾判死真的生效了吗？
 *
 * 关键测量口径（前两版踩过的坑，写在这里防再犯）：
 *   · **重的同步 eval（模拟几百帧克隆世界）期间，真游戏会在两次 eval 之间偷偷推进若干帧**
 *     ==> 1) 沙箱预测 + 探针独立复算 **必须在同一个 eval 内**完成（零帧滑移）
 *         2) 游戏侧帧号必须用"状态滑移"校正（slip）
 *   · adapter 是 **per-player** 的：createAdapter(gc, aiId) 的 aiId 必须是场上真坦克 id
 *   · 毒雾判死按 `_frameDtSec` 推进 ==> 对拍前必须 `setFrameDtSec(游戏实测帧长)`
 *
 *   1 三路对拍（A 自然注入 t=0 / B 强制注入 side=-1,t=5；含"未校准"对照）
 *   2 假阳/假阴矩阵（多档 storm 状态 x 全可达格位；同一 eval 内比）
 *   3 不推坦克（注入前/后 samples 逐字节相同 + 真游戏位姿零漂移 + 与游戏逐帧位姿一致）
 *   4 与 S1 移除链交互（毒雾死 + 弹被移除 不许复活）
 *   5 无风暴（audit=null 且不判死）
 * 用法：node _tools/headless/_s1_storm_final_probe.js
 * 产物：_tools/headless/_s1_prof/_s1_storm_probe.json（日志 < 100KB）
 * ============================================================================ */
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const { Match } = require('./match');
const PROF = path.join(__dirname, '_s1_prof');
const FILES = [
  'game_core/js/vantage_sandbox.js', 'game_core/js/vantage_tree.js', 'game_core/index.html',
  'game_core/rust/diff_tree_low_eval_frames.js',
  'game_core/js/b714588dc4621fe104113111ba90b1a7.js', 'game_core/js/7b2ed8ad3598d7321f8f3d2b04b1eac8.js',
  'game_core/js/54518faa8d672020d7af8ed7c353bc1b.js', 'game_core/js/46989e393ad0e356ac8a0c6c53b362f9.js',
  '_tools/headless/match.js',
];
function fp() {
  const o = [];
  for (const r of FILES) { const p = path.join(__dirname, '..', '..', r);
    try { const st = fs.statSync(p); o.push({ file: r, mtime: st.mtime.toISOString(), bytes: st.size,
      md5: crypto.createHash('md5').update(fs.readFileSync(p)).digest('hex') }); }
    catch (e) { o.push({ file: r, err: String(e.message || e) }); } }
  return o;
}
const T0 = Date.now();
const rep = { startedAt: new Date().toISOString(), fingerprints: fp() };
const P = (...a) => console.log(...a);
const fails = [];
function check(name, ok, detail) { if (!ok) fails.push(name + ' :: ' + JSON.stringify(detail)); P('   [' + (ok ? 'PASS' : 'FAIL') + '] ' + name + (detail ? ' ' + JSON.stringify(detail) : '')); return ok; }

const H = [
  'window.__s = {',
  '  gc: function () { return GameManager.getGameController(); },',
  '  r4: function (x) { return (x === null || x === undefined) ? null : Math.round(x * 10000) / 10000; },',
  '  storm: function () {',
  '    var zs = this.gc().getZones(); var z = null, zid = null;',
  '    for (var k in zs) { if (zs.hasOwnProperty(k) && zs[k].getType() === Constants.ZONE_TYPES.STORM) { z = zs[k]; zid = k; break; } }',
  '    if (!z) return null;',
  '    return { id: zid, t: z._expansionTime, side: z._expansionSide,',
  '             r: z._expansionTilesRight, b: z._expansionTilesBottom, l: z._expansionTilesLeft, tp: z._expansionTilesTop,',
  '             seq: z._expansionSequence.slice(), tb: z._tileBounds,',
  '             TILE: Constants.MAZE_TILE_SIZE.m, WALL: Constants.MAZE_WALL_WIDTH.m,',
  '             GROW: Constants.STORM_ZONE_START_GROW_TIME, CYCLE: Constants.STORM_ZONE_EXPANSION_TIME };',
  '  },',
  '  copy: function (s) { return { t: s.t, side: s.side, r: s.r, b: s.b, l: s.l, tp: s.tp,',
  '    seq: s.seq.slice(), tb: { minX: s.tb.minX, minY: s.tb.minY, maxX: s.tb.maxX, maxY: s.tb.maxY },',
  '    TILE: s.TILE, WALL: s.WALL, GROW: s.GROW, CYCLE: s.CYCLE }; },',
  '  step: function (s, dt) {',
  '    s.t -= dt;',
  '    if (s.t <= s.GROW) { if (s.side < 0) { s.side = s.seq[s.r + s.b + s.l + s.tp];',
  '      if (s.side === 0) s.r++; else if (s.side === 1) s.b++; else if (s.side === 2) s.l++; else if (s.side === 3) s.tp++; } }',
  '    if (s.t <= 0) { s.side = -1; s.t = s.CYCLE; }',
  '    return s;',
  '  },',
  '  rect: function (s) {',
  '    var ratio = Math.max(0, Math.min(1, (s.GROW - s.t) / s.GROW)), tb = s.tb;',
  '    return { R: ((tb.maxX + 1) - (s.r - (s.side === 0 ? 1 - ratio : 0))) * s.TILE,',
  '             B: ((tb.maxY + 1) - (s.b - (s.side === 1 ? 1 - ratio : 0))) * s.TILE,',
  '             L: (tb.minX + s.l - (s.side === 2 ? 1 - ratio : 0)) * s.TILE,',
  '             T: (tb.minY + s.tp - (s.side === 3 ? 1 - ratio : 0)) * s.TILE };',
  '  },',
  '  overshootBase: function (x, y, rot, rect, HW, HH) {',
  '    var c = Math.cos(rot), sn = Math.sin(rot), worst = -Infinity;',
  '    var pts = [[-HW, -HH], [HW, -HH], [HW, HH], [-HW, HH]];',
  '    for (var i = 0; i < 4; i++) {',
  '      var wx = x + c * pts[i][0] - sn * pts[i][1], wy = y + sn * pts[i][0] + c * pts[i][1];',
  '      var ov = rect.L - wx; if (wx - rect.R > ov) ov = wx - rect.R;',
  '      if (rect.T - wy > ov) ov = rect.T - wy; if (wy - rect.B > ov) ov = wy - rect.B;',
  '      if (ov > worst) worst = ov;',
  '    }',
  '    return worst;',
  '  },',
  '  oracleFd: function (s0, x, y, rot, N, dt) {',
  '    var s = this.copy(s0); var HW = Constants.TANK.WIDTH.m / 2, HH = Constants.TANK.HEIGHT.m / 2;',
  '    for (var k = 1; k <= N; k++) { if (this.overshootBase(x, y, rot, this.rect(s), HW, HH) >= 0) return k; this.step(s, dt); }',
  '    return -1;',
  '  },',
  '  slip: function (s0, observed, dt, maxK) {',
  '    var s = this.copy(s0);',
  '    for (var k = 0; k <= maxK; k++) {',
  '      if (Math.abs(s.t - observed.t) < 1e-9 && s.side === observed.side &&',
  '          s.r === observed.r && s.b === observed.b && s.l === observed.l && s.tp === observed.tp) return k;',
  '      this.step(s, dt);',
  '    }',
  '    return null;',
  '  },',
  '  joint: function (id, x, y, rot, N, dt, withSamples) {',
  '    var arr = [{ samples: (function () { var a = []; for (var k = 0; k <= N; k++) a.push({ t: k * dt, x: x, y: y, rot: rot }); return a; })(), dead: false, deathFrame: -1 }];',
  '    VantageSandbox.applyStormDeaths(this.gc(), id, arr, N);',
  '    var geom = { fd: arr[0].deathFrame, ov: (arr[0].stormOvershoot === undefined ? null : arr[0].stormOvershoot) };',
  '    var ad = VantageSandbox.createAdapter(this.gc(), id);',
  '    var r = ad.simulateTank({ x: x, y: y, rot: rot }, { forward: false, back: false, left: false, right: false }, N, { startPose: { x: x, y: y, rot: rot } });',
  '    var s = this.storm();',
  '    var out = { geomFd: geom.fd, geomOv: geom.ov, sbFd: r.deathFrame, sbDead: !!r.dead, sbStorm: !!r.stormDeath,',
  '                n: (r.samples || []).length };',
  '    if (s) { out.sFull = this.copy(s); out.state = { t: s.t, side: s.side, r: s.r, b: s.b, l: s.l, tp: s.tp };',
  '             out.rect0 = this.rect(s); out.oracleFd = this.oracleFd(s, x, y, rot, N, dt); }',
  '    if (withSamples) out.samples = r.samples;',
  '    return out;',
  '  },',
  '  inject: function (id) {',
  '    var gc = this.gc(); var mz = gc.getMaze();',
  '    gc.roundController.setZoneState(StormZone.createInitialZoneState(id, mz.getStormExpansionSequence(), mz.getTileBounds()));',
  '    return this.storm();',
  '  },',
  '  force: function (id) { var z = this.gc().getZones()[id]; z._expansionSide = -1; z._expansionTime = Constants.STORM_ZONE_START_GROW_TIME;',
  '    return { side: z._expansionSide, t: this.r4(z._expansionTime) }; },',
  '  drop: function (id) { try { this.gc().roundController.destroyZone(id); } catch (e) { return String(e); } return "dropped"; },',
  '  cells: function () { var mz = this.gc().getMaze(); var tb = mz.getTileBounds(); var t = mz.getTiles(); var out = [];',
  '    for (var i = 0; i < t.length; i++) for (var j = 0; j < t[i].length; j++) if (t[i][j][0] === 1) out.push({ x: i, y: j });',
  '    return { bounds: tb, TILE: Constants.MAZE_TILE_SIZE.m, cells: out }; },',
  '  tankPos: function (id) { var t = this.gc().getTank(id); return t ? { x: this.r4(t.getX()), y: this.r4(t.getY()), rot: this.r4(t.getRotation()) } : null; },',
  '  setTank: function (id, x, y, rot) { var gc = this.gc();',
  '    gc.setTankState(TankState.withState(id, x, y, false, false, rot, false, false, false, false), false);',
  '    return this.tankPos(id); },',
  '  audit: function () { return VantageSandbox.getStormDeathAudit(); },',
  '  deaths: function () { try { var AD = VantageSandbox.createAdapter(this.gc(), "tank_a");',
  '    return AD.getDeaths().map(function (r) { return { v: r.victimPlayerId, src: r.src, cause: r.cause, x: r.x, y: r.y, cx: r.contactX, cy: r.contactY }; }); } catch (e) { return String(e); } },',
  '  measureDt: function () { var t0 = window.__vt.t; window.__vtStep(60); var t1 = window.__vt.t;',
  '    return { dt: (t1 - t0) / 60 / 1000, t0: t0, t1: t1 }; }',
  '};'
].join('\n');

(async () => {
  let m = null;
  try {
    fs.mkdirSync(PROF, { recursive: true });
    m = new Match();
    await m.open({ humanIds: ['tank_a', 'tank_b', 'tank_c'], aiCount: 0, vantCount: 0 });
    await m.clearControl(); await m.eval(H);
    const DT0 = await m.eval('VantageSandbox.getFrameDtSec()');
    rep.frameDtDefault = DT0;
    const dtm = await m.eval('window.__s.measureDt()');
    const DT = dtm.dt;
    rep.measuredDt = dtm;
    rep.version = await m.eval('(typeof VantageTree !== "undefined" && VantageTree.VERSION) ? VantageTree.VERSION : null');
    P('0) sandbox default dt=' + DT0 + '  game measured dt=' + DT + '  version=' + rep.version);

    async function waitRound() {
      for (let i = 0; i < 160; i++) {
        const st = await m.eval('({s: GameManager.getGameController().getState(), n: Object.keys(GameManager.getGameController().getTanks()).length, mz: !!GameManager.getGameController().getMaze()})');
        if (String(st.s).indexOf('in round') >= 0 && st.n >= 3 && st.mz) { await m.pump(3); return { ok: true, at: st }; }
        await m.pump(30);
      }
      return { ok: false };
    }
    async function restartRound(tag) {
      await m.eval('(() => { try { GameManager.getGameController().endRound(false); } catch(e){} return 1; })()');
      const w = await waitRound();
      await m.eval('VantageSandbox.setFrameDtSec(' + DT + ')');
      if (!w.ok) throw new Error('restartRound failed at ' + tag);
      return w;
    }
    async function injectRetry(id) {
      let last = null;
      for (let a = 0; a < 10; a++) {
        try { return await m.eval('window.__s.inject(' + JSON.stringify(id) + ')'); }
        catch (e) { last = String((e && e.message) || e); await m.pump(30); }
      }
      throw new Error('inject failed: ' + id + ' last=' + last);
    }

    /* ================= 3 不推坦克（第一回合，无击杀） ================= */
    const M3 = rep.noPush = {};
    {
      const ci = await m.eval('window.__s.cells()');
      const c0 = ci.cells[Math.floor(ci.cells.length / 2)];
      const x = c0.x * ci.TILE + ci.TILE / 2, y = c0.y * ci.TILE + ci.TILE / 2;
      await m.eval('window.__s.setTank("tank_b", ' + x + ', ' + y + ', 0)');
      await m.pump(3);
      const before = await m.eval('window.__s.joint("tank_b", ' + x + ', ' + y + ', 0, 300, ' + DT + ', true)');
      await injectRetry('s1a');
      const auditAt = await m.eval('window.__s.audit()');
      const after = await m.eval('window.__s.joint("tank_b", ' + x + ', ' + y + ', 0, 300, ' + DT + ', true)');
      M3.auditRect0 = auditAt ? auditAt.rect0 : null;
      M3.beforeFd = before.sbFd; M3.afterFd = after.sbFd; M3.oracleFd = after.oracleFd;
      M3.samplesIdentical = JSON.stringify(before.samples) === JSON.stringify(after.samples);
      check('3 注入毒雾前后 沙箱 samples 逐字节相同（不推坦克）', M3.samplesIdentical, { n: (before.samples || []).length });
      check('3 毒雾在场 物理无改动（fd 不变）', before.sbFd === after.sbFd, { before: before.sbFd, after: after.sbFd });
      const gs = [];
      for (let k = 0; k < 40; k++) { await m.pump(1); gs.push(await m.eval('window.__s.tankPos("tank_b")')); }
      let drift = 0; for (const g of gs) if (g) drift = Math.max(drift, Math.hypot(g.x - x, g.y - y));
      M3.gameDriftWithStorm = +drift.toFixed(6);
      const r6 = (v) => Math.round(v * 1e6) / 1e6;
      const sb = (after.samples || []).slice(0, 41).map((s) => [r6(s.x), r6(s.y)]);
      const gm = gs.map((g) => g ? [r6(g.x), r6(g.y)] : null);
      M3.poseMatchGame = JSON.stringify(sb) === JSON.stringify(gm);
      M3.sbFirst = sb[0]; M3.gsFirst = gm[0]; M3.sbLast = sb[sb.length - 1]; M3.gsLast = gm[gm.length - 1];
      check('3 毒雾在场：真游戏位姿零漂移', M3.gameDriftWithStorm < 1e-6, { drift: M3.gameDriftWithStorm });
      check('3 沙箱 samples 与真游戏逐帧位姿一致', M3.poseMatchGame, { sb0: M3.sbFirst, gs0: M3.gsFirst, sbN: M3.sbLast, gsN: M3.gsLast });

      /* ================= 4 与 S1 移除链交互 ================= */
      const r4 = await m.eval('(() => { var gc = GameManager.getGameController();'
        + ' var arr = [{ samples: (function(){ var a=[]; for(var k=0;k<=60;k++) a.push({t:k*0.02,x:-9999,y:-9999,rot:0}); return a; })(), dead: false, deathFrame: -1 }];'
        + ' VantageSandbox.applyStormDeaths(gc, "tank_a", arr, 60);'
        + ' return { stormFd: arr[0].deathFrame, stormOv: arr[0].stormOvershoot }; })()');
      rep.s1Interact = r4;
      const chain = await m.eval('(() => VantageSandbox.releaseDeathsAfterRemoval([{ dead: true, deathFrame: 50 }], ["X"], [{ op: 0, causes: [] }]).results[0])()');
      rep.s1Chain = chain;
      check('4 远出界样本被毒雾判死', r4.stormFd >= 1, r4);
      check('4 毒雾死不会被移除链复活', chain.dead === true && chain.deathFrame === 50, chain);

      /* ================= 5 无风暴 ================= */
      await m.eval('window.__s.drop("s1a")');
      const aud = await m.eval('window.__s.audit()');
      const j5 = await m.eval('window.__s.joint("tank_b", ' + x + ', ' + y + ', 0, 120, ' + DT + ', false)');
      check('5 无风暴：audit=null 且不判死', aud === null && j5.sbFd < 0 && j5.geomFd < 0 && j5.oracleFd === -1,
        { audit: aud, sbFd: j5.sbFd, geomFd: j5.geomFd, oracleFd: j5.oracleFd });
    }

    /* ================= 1 三路对拍 ================= */
    function pickCells(info, first) {
      const tb = info.bounds, T = info.TILE;
      const line = (idx) => first === 0 ? { axis: 'x', v: tb.maxX - idx } : first === 2 ? { axis: 'x', v: tb.minX + idx }
        : first === 1 ? { axis: 'y', v: tb.maxY - idx } : { axis: 'y', v: tb.minY + idx };
      const at = (ln, other) => (ln.axis === 'x')
        ? { x: ln.v * T + T / 2, y: other * T + T / 2, cell: { x: ln.v, y: other } }
        : { x: other * T + T / 2, y: ln.v * T + T / 2, cell: { x: other, y: ln.v } };
      const l0 = line(0);
      const cs = info.cells.filter((c) => (l0.axis === 'x' ? c.x === l0.v : c.y === l0.v));
      const out = {};
      out.P1 = at(l0, l0.axis === 'x' ? cs[0].y : cs[0].x);
      out.P3 = at(l0, l0.axis === 'x' ? cs[cs.length - 1].y : cs[cs.length - 1].x);
      let best = null;
      for (const c of info.cells) {
        const d = l0.axis === 'x' ? Math.abs(c.x - l0.v) : Math.abs(c.y - l0.v);
        if (!best || d > best.d) best = { d: d, cell: c };
      }
      out.P2 = { x: best.cell.x * T + T / 2, y: best.cell.y * T + T / 2, cell: best.cell };
      return out;
    }
    for (const sc of [['A_natural', false, 900], ['B_forced', true, 220]]) {
      const tag = sc[0], forced = sc[1], N = sc[2];
      const S = rep[tag] = { forced: forced, dtUsed: DT, N: N };
      await restartRound(tag);
      const ci = await m.eval('window.__s.cells()');
      const st0 = await injectRetry('s1_' + tag);
      S.seq = st0.seq.slice(0, 8);
      if (forced) S.forceApplied = await m.eval('window.__s.force("s1_' + tag + '")');
      const picks = pickCells(ci, st0.seq[0]);
      S.picks = picks;
      P('');
      P('1 [' + tag + '] seq[0]=' + st0.seq[0] + ' P1=' + JSON.stringify(picks.P1.cell) + ' P2=' + JSON.stringify(picks.P2.cell) + ' P3=' + JSON.stringify(picks.P3.cell));
      const plan = [['tank_b', picks.P1], ['tank_c', picks.P2], ['tank_a', picks.P3]];
      S.rows = [];
      for (const pl of plan) {
        S.rows.push({ id: pl[0], cell: pl[1].cell, placed: await m.eval('window.__s.setTank("' + pl[0] + '", ' + pl[1].x + ', ' + pl[1].y + ', 0)') });
      }
      await m.pump(2);
      for (const r of S.rows) {
        r.placed = await m.eval('window.__s.tankPos("' + r.id + '")');
        r.joint = await m.eval('window.__s.joint("' + r.id + '", ' + r.placed.x + ', ' + r.placed.y + ', ' + r.placed.rot + ', ' + N + ', ' + DT + ', false)');
        delete r.joint.samples;
      }
      if (!forced) {
        await m.eval('VantageSandbox.setFrameDtSec(0.02)');
        S.uncalibrated = await m.eval('window.__s.joint("tank_b", ' + S.rows[0].placed.x + ', ' + S.rows[0].placed.y + ', ' + S.rows[0].placed.rot + ', ' + N + ', 0.02, false)');
        delete S.uncalibrated.samples;
        await m.eval('VantageSandbox.setFrameDtSec(' + DT + ')');
      }
      const obs = await m.eval('window.__s.storm()');
      const slip = await m.eval('window.__s.slip(' + JSON.stringify(S.rows[0].joint.sFull) + ', ' + JSON.stringify(obs) + ', ' + DT + ', 600)');
      S.slip = slip; S.obsState = obs ? { t: obs.t, side: obs.side, r: obs.r, b: obs.b, l: obs.l, tp: obs.tp } : null;
      S.jointState = S.rows[0].joint.state;
      const gameDead = { tank_a: -1, tank_b: -1, tank_c: -1 };
      for (let k = 1; k <= N; k++) {
        await m.pump(1);
        const al = await m.eval('({a: !!GameManager.getGameController().getTank("tank_a"), b: !!GameManager.getGameController().getTank("tank_b"), c: !!GameManager.getGameController().getTank("tank_c")})');
        if (!al.a && gameDead.tank_a < 0) gameDead.tank_a = k;
        if (!al.b && gameDead.tank_b < 0) gameDead.tank_b = k;
        if (!al.c && gameDead.tank_c < 0) gameDead.tank_c = k;
        if (gameDead.tank_a >= 0 && gameDead.tank_b >= 0 && gameDead.tank_c >= 0) break;
      }
      S.gameDead = gameDead;
      S.deaths = await m.eval('window.__s.deaths()');
      const near = (a, b) => (a < 0 && b < 0) || (a >= 0 && b >= 0 && Math.abs(a - b) <= 1);
      for (const r of S.rows) {
        r.gameFdRaw = gameDead[r.id];
        r.gameFdAdj = (r.gameFdRaw >= 0 && typeof slip === 'number') ? (r.gameFdRaw + slip) : r.gameFdRaw;
        r.deltaAdj = (r.gameFdAdj >= 0 && r.joint.sbFd >= 0) ? (r.joint.sbFd - r.gameFdAdj) : null;
        P('   ' + r.id + ' @' + JSON.stringify(r.cell) + ' sandboxFd=' + r.joint.sbFd + ' oracleFd=' + r.joint.oracleFd +
          ' geomFd=' + r.joint.geomFd + ' gameFdRaw=' + r.gameFdRaw + ' gameFdAdj=' + r.gameFdAdj + ' delta=' + r.deltaAdj);
      }
      P('   [state] joint=' + JSON.stringify(S.jointState) + ' observed=' + JSON.stringify(S.obsState) + ' slip=' + slip);
      check(tag + ': sandbox vs probe-oracle (+-1)', S.rows.every((r) => near(r.joint.sbFd, r.joint.oracleFd)),
        { d: S.rows.map((r) => [r.id, r.joint.sbFd, r.joint.oracleFd]) });
      check(tag + ': sandbox vs geometry-layer (+-1)', S.rows.every((r) => near(r.joint.sbFd, r.joint.geomFd)),
        { d: S.rows.map((r) => [r.id, r.joint.sbFd, r.joint.geomFd]) });
      check(tag + ': sandbox vs real game (slip-adjusted, +-1)', S.rows.every((r) => near(r.joint.sbFd, r.gameFdAdj)),
        { d: S.rows.map((r) => [r.id, r.joint.sbFd, r.gameFdAdj, r.gameFdRaw]) });
      check(tag + ': at least one storm kill', S.rows.some((r) => r.joint.sbFd >= 0 && r.joint.sbStorm),
        { d: S.rows.map((r) => r.joint.sbFd) });
      if (S.uncalibrated) P('   [ctrl] uncalibrated dt=0.02 -> sbFd=' + S.uncalibrated.sbFd + ' (calibrated: ' + S.rows[0].joint.sbFd + ')');
    }

    /* ================= 2 假阳/假阴矩阵 ================= */
    const M2 = rep.matrix = { fp: 0, fn: 0, frameMismatch: 0, n: 0, sample: [] };
    {
      await restartRound('matrix');
      const ci = await m.eval('window.__s.cells()');
      await injectRetry('s1m');
      const N = 700;
      const seq0 = (await m.eval('window.__s.storm()')).seq[0];
      const states = [
        ['t0', null],
        ['idle_t8', '(() => { var z=GameManager.getGameController().getZones()["s1m"]; z._expansionSide=-1; z._expansionTime=8.0; return 1; })()'],
        ['grow_t2p5', '(() => { var z=GameManager.getGameController().getZones()["s1m"]; z._expansionSide=' + seq0 + '; z._expansionTime=2.5;'
          + ' if(' + seq0 + '===0) z._expansionTilesRight+=1; else if(' + seq0 + '===1) z._expansionTilesBottom+=1; else if(' + seq0 + '===2) z._expansionTilesLeft+=1; else z._expansionTilesTop+=1; return 1; })()'],
      ];
      for (const st of states) {
        if (st[1]) await m.eval(st[1]);
        for (const c of ci.cells) {
          const x = c.x * ci.TILE + ci.TILE / 2, y = c.y * ci.TILE + ci.TILE / 2;
          const j = await m.eval('window.__s.joint("tank_a", ' + x + ', ' + y + ', 0, ' + N + ', ' + DT + ', false)');
          M2.n++;
          const both = (j.geomFd >= 0 && j.oracleFd >= 0), neither = (j.geomFd < 0 && j.oracleFd < 0);
          if (!both && !neither) { if (j.geomFd >= 0) M2.fp++; else M2.fn++; }
          else if (both && j.geomFd !== j.oracleFd) M2.frameMismatch++;
          if (M2.sample.length < 12) M2.sample.push({ st: st[0], cell: c, sb: j.sbFd, geom: j.geomFd, oracle: j.oracleFd });
        }
      }
      check('2 matrix fp=0', M2.fp === 0, { fp: M2.fp, n: M2.n });
      check('2 matrix fn=0', M2.fn === 0, { fn: M2.fn, n: M2.n });
      check('2 matrix frameMismatch=0', M2.frameMismatch === 0, { mm: M2.frameMismatch, n: M2.n });
      P('2 matrix n=' + M2.n + ' fp=' + M2.fp + ' fn=' + M2.fn + ' frameMismatch=' + M2.frameMismatch);
    }

    rep.fails = fails;
    P('');
    P('===== RESULT: ' + (fails.length ? ('FAIL ' + fails.length) : 'ALL PASS') + ' =====');
    fails.forEach((f) => P('  x ' + f));
  } catch (e) { rep.err = String((e && e.stack) || e); P('X: ' + rep.err); }
  finally {
    try { if (m) await m.close(); } catch (e) {}
    try { fs.writeFileSync(path.join(PROF, '_s1_storm_probe.json'), JSON.stringify(rep, null, 1)); } catch (e) {}
    P('[done] ' + ((Date.now() - T0) / 1000).toFixed(1) + 's');
    process.exitCode = fails.length ? 1 : 0;
  }
})();
