'use strict';
/* 只读探针（盲区危害判定用，2026-10-12）。不改 game_core 一个字节。
 * 口径：dumpDiagnostics().liveAnchors[]（AGENTS 2026-10-12 新定）。
 *   目标① 证/伪「len<needFrames 的寿命截断型轨迹」= 弹剩余寿命快到了，而不是"重模拟失败"。
 *     恒等式：(a) 取位 null_now ⟺ round(Δ/tdt)>=len ⟺ Δ>=cover ⟺ 真弹 lifeLeft<=0
 *             (b) 深节点越界 blind ⟺ Δ+horizon>cover ⟺ horizon>真弹 lifeLeft
 *   目标② 把 liveAnchors 和真游戏弹状态对拍：
 *     realAlive = pr 仍在 GameController.getProjectiles() 且 !pr.done()
 *     null_now && realAlive = "树看不见、真游戏还活着"（假绿候选）
 * 用法: node _tools/headless/_probe_blindharm.js --frames=1200 --tag=A
 */
const { Match } = require('./match');

const PAGE_SRC = `(() => {
  if (window.__bh) return 'exists';
  window.__bh = function () {
    var out = { ok: false };
    try {
      var d = VantageTree.dumpDiagnostics();
      var t = VantageTree.getTree ? VantageTree.getTree() : null;
      if (!d || !t) return { ok: false, why: 'no-tree' };
      var gc = (typeof GameManager !== 'undefined' && GameManager.getGameController) ? GameManager.getGameController() : null;
      var proj = (gc && gc.getProjectiles) ? gc.getProjectiles() : null;
      var deepest = 0, ends = [];
      try { t.walk(function (n) { if (n && typeof n.tEndSec === 'number') { if (n.tEndSec > deepest) deepest = n.tEndSec; if (n !== t.root) ends.push(Math.round(n.tEndSec * 1000) / 1000); } }); } catch (e2) {}
      out.ok = true;
      out.ver = VantageTree.VERSION || null;
      out.t = d.tNow; out.rootAbsT = d.rootAbsT; out.deepest = deepest;
      out.need = (t.diag && typeof t.diag.trackFrames === 'number') ? t.diag.trackFrames : null;
      out.ticking = !!(t.diag && typeof t.diag.lastCheckAt === 'number' && Math.abs(t.diag.lastCheckAt - d.tNow) < 1e-9);
      out.liveProj = d.liveProjectileCount; out.ends = ends;
      out.rows = (d.liveAnchors || []).map(function (a) {
        var tdt = (a.trackDt && a.trackDt > 0) ? a.trackDt : 0.0166666667;
        var cover = (a.trackLen || 0) * tdt;
        var pr = (proj && a.id !== undefined && proj.hasOwnProperty(a.id)) ? proj[a.id] : null;
        var o = { id: a.id, delta: a.delta, len: a.trackLen || 0, tdt: tdt, cover: cover,
          abs0: a.abs0, hasTrack: a.hasTrack ? 1 : 0, hasPath: a.hasPath ? 1 : 0,
          idxNow: Math.round(a.delta / tdt), real: pr ? 1 : 0 };
        if (pr) {
          o.type = pr.getType ? pr.getType() : null;
          o.lifeTotal = (typeof pr.lifetime === 'number') ? pr.lifetime : null;
          o.lifeAge = pr.getTimeAlive ? pr.getTimeAlive() : null;
          o.lifeLeft = (o.lifeTotal !== null && o.lifeAge !== null) ? (o.lifeTotal - o.lifeAge) : null;
          o.done = pr.done ? (pr.done() ? 1 : 0) : null;
          o.stopped = pr.stopped ? 1 : 0;
          o.nB = (pr.bounces && pr.bounces.length) ? pr.bounces.length : 0;
        }
        return o;
      });
      return out;
    } catch (e) { out.err = String((e && e.message) || e); return out; }
  };
  return 'ok';
})()`;

const r3 = (x) => (typeof x === 'number' ? Math.round(x * 1000) / 1000 : x);
const r4 = (x) => (typeof x === 'number' ? Math.round(x * 10000) / 10000 : x);
const pct = (a, p) => { if (!a.length) return null; const b = a.slice().sort((x, y) => x - y); return b[Math.min(b.length - 1, Math.max(0, Math.floor(p * b.length)))]; };
const cnt = (a, f) => a.filter(f).length;
const num = (v) => typeof v === 'number' && isFinite(v);

(async () => {
  const frames = Number((process.argv.find((a) => a.startsWith('--frames=')) || '').split('=')[1] || 1200);
  const tag = (process.argv.find((a) => a.startsWith('--tag=')) || '--tag=?').split('=')[1];
  const m = new Match();
  const t0 = Date.now();
  const rows = [], gen = {};
  let ver = null, framesOk = 0, tickFrames = 0, maxNodes = 0, genSeq = 0;
  try {
    await m.open({ humanIds: ['tank_a'], aiCount: 1, vantCount: 2 });
    await m.eval(PAGE_SRC);
    for (let f = 0; f < frames; f++) {
      if (f % 30 === 0) {
        const rot = (f / 30) * 0.35;
        await m.eval(`(() => { var gc = GameManager.getGameController(); var a = gc.getTank ? gc.getTank('tank_a') : null;
          if (a && gc.setTankState) gc.setTankState(TankState.withState('tank_a', a.getX(), a.getY(), false,false, ${rot}, false,false,false,false), false);
          window.__vtCtrl.fire = true; return 1; })()`);
      }
      await m.pump(1);
      const s = await m.eval('window.__bh()').catch(() => null);
      if (!s || !s.ok) continue;
      framesOk++;
      if (ver === null) ver = s.ver;
      if (s.ticking) tickFrames++;
      if ((s.ends || []).length > maxNodes) maxNodes = s.ends.length;
      const ends = s.ends || [];
      for (const rr of (s.rows || [])) {
        let blind = 0;
        for (let i = 0; i < ends.length; i++) if ((ends[i] - s.t) + rr.delta > rr.cover) blind++;
        rows.push(Object.assign({ t: s.t, horizon: r4(s.deepest - s.t), need: s.need, blind, nodes: ends.length }, rr));
        const gk = String(rr.id) + '@' + r3(rr.abs0);
        let g = gen[gk];
        if (!g) { g = gen[gk] = { seq: ++genSeq, id: rr.id, abs0: r3(rr.abs0), t0: r3(s.t), n: 0, len0: rr.len, cover0: r4(rr.cover),
          lifeLeft0: rr.lifeLeft, real0: rr.real, type: rr.type, nB0: rr.nB, stopped0: rr.stopped, done0: rr.done,
          deltaMax: 0, minLen: 1e9, lenMax: 0, minLifeLeft: null, lastT: 0 }; }
        g.n++;
        if (rr.delta > g.deltaMax) g.deltaMax = rr.delta;
        if (rr.len < g.minLen) g.minLen = rr.len;
        if (rr.len > g.lenMax) g.lenMax = rr.len;
        if (num(rr.lifeLeft) && (g.minLifeLeft === null || rr.lifeLeft < g.minLifeLeft)) g.minLifeLeft = rr.lifeLeft;
        if (s.t > g.lastT) g.lastT = s.t;
      }
    }
    await m.clearControl();
  } catch (e) { console.error('FAILED:', (e && e.stack) || e); process.exitCode = 1; }
  finally { try { await m.close(); } catch (e) {} }

  const needVals = {}; for (const r of rows) if (num(r.need)) needVals[r.need] = (needVals[r.need] || 0) + 1;
  const needRef = Object.keys(needVals).map(Number).sort((a, b) => needVals[b] - needVals[a])[0] || null;
  const isFull = (r) => num(r.need) && r.len >= r.need;
  const short = rows.filter((r) => !isFull(r)), fullw = rows.filter(isFull);
  const nullNow = (r) => (r.hasTrack ? (r.idxNow >= r.len) : true);
  const realAlive = (r) => (r.real === 1 && r.done !== 1);
  const cross = { nn_ra: 0, nn_rd: 0, ok_ra: 0, ok_rd: 0, nn_noreal: 0, ok_noreal: 0 };
  for (const r of rows) { const n = nullNow(r), a = realAlive(r);
    if (n && a) cross.nn_ra++; else if (n && r.real === 1) cross.nn_rd++; else if (n) cross.nn_noreal++;
    else if (a) cross.ok_ra++; else if (r.real === 1) cross.ok_rd++; else cross.ok_noreal++; }
  const errs = short.filter((r) => num(r.lifeLeft) && r.real === 1).map((r) => r4(r.cover - r.delta - r.lifeLeft));
  const errsAll = rows.filter((r) => num(r.lifeLeft) && r.real === 1).map((r) => r4(r.cover - r.delta - r.lifeLeft));
  const covs = short.map((r) => r.cover);
  const nnra = rows.filter((r) => nullNow(r) && realAlive(r));
  const blindRows = rows.filter((r) => r.blind > 0), nonBlind = rows.filter((r) => r.blind === 0);
  const bWithLife = blindRows.filter((r) => num(r.lifeLeft) && r.real === 1);
  const nbWithLife = nonBlind.filter((r) => num(r.lifeLeft) && r.real === 1);

  console.log('=== 盲区危害判定探针 [' + tag + '] VERSION=' + ver + ' ===');
  console.log('帧=' + frames + ' 有效帧=' + framesOk + ' tick帧=' + tickFrames + ' 节点数最大=' + maxNodes + ' needFrames(众数)=' + needRef + ' 锚点样本行=' + rows.length);
  console.log('--- 1. 分类：满窗口型 vs 寿命截断型 ---');
  console.log('  满窗口型(len>=need) n=' + fullw.length + '   寿命截断型(len<need) n=' + short.length);
  console.log('  截断型 cover 分布: min=' + r4(pct(covs, 0)) + ' med=' + r4(pct(covs, .5)) + ' p90=' + r4(pct(covs, .9)) + ' max=' + r4(pct(covs, 1)) +
    ' | cover<0.2s 行=' + cnt(covs, (c) => c < 0.2) + ' cover<1s=' + cnt(covs, (c) => c < 1) + ' cover<8s=' + cnt(covs, (c) => c < 8));
  console.log('  截断型里 真弹还在(real=1)=' + cnt(short, (r) => r.real === 1) + '/' + short.length +
    '  真弹已 done=' + cnt(short, (r) => r.done === 1) + '  弹不存在=' + cnt(short, (r) => r.real === 0));
  console.log('--- 2. 恒等式 cover−Δ−lifeLeft（真游戏剩余寿命）---');
  console.log('  全部样本 n=' + errsAll.length + ' min=' + r4(pct(errsAll, 0)) + ' med=' + r4(pct(errsAll, .5)) + ' p90=' + r4(pct(errsAll, .9)) + ' max=' + r4(pct(errsAll, 1)) + ' |err|<=1帧=' + cnt(errsAll, (e) => Math.abs(e) <= 0.017));
  console.log('  截断型 n=' + errs.length + ' min=' + r4(pct(errs, 0)) + ' med=' + r4(pct(errs, .5)) + ' p90=' + r4(pct(errs, .9)) + ' max=' + r4(pct(errs, 1)) + ' |err|<=1帧=' + cnt(errs, (e) => Math.abs(e) <= 0.017) + ' |err|<=2帧=' + cnt(errs, (e) => Math.abs(e) <= 0.034));
  console.log('--- 3. 取位 null_now × 真游戏弹状态 ---');
  console.log('  null_now & 真弹活着(假绿候选)=' + cross.nn_ra + ' | null_now & 真弹done=' + cross.nn_rd + ' | null_now & 弹不存在=' + cross.nn_noreal);
  console.log('  取位正常 & 真弹活着=' + cross.ok_ra + ' | 取位正常 & 真弹done=' + cross.ok_rd + ' | 取位正常 & 弹不存在=' + cross.ok_noreal);
  console.log('  ⚠假绿候选里 寿命截断型=' + cnt(nnra, (r) => !isFull(r)) + ' 满窗口型=' + cnt(nnra, isFull));
  console.log('--- 4. 深节点越界(盲区) × 真弹剩余寿命 ---');
  console.log('  盲区行=' + blindRows.length + '/' + rows.length + ' (' + r3(100 * blindRows.length / Math.max(1, rows.length)) + '%)  单行盲区节点数最大=' + (blindRows.length ? Math.max.apply(null, blindRows.map((r) => r.blind)) : 0));
  console.log('  盲区行里 真弹还活着=' + cnt(blindRows, realAlive) + '/' + blindRows.length + ' | 盲区行里 horizon>lifeLeft(=深节点必已死)=' + cnt(bWithLife, (r) => r.horizon > r.lifeLeft) + '/' + bWithLife.length);
  console.log('  非盲区行里 horizon>lifeLeft=' + cnt(nbWithLife, (r) => r.horizon > r.lifeLeft) + '/' + nbWithLife.length);
  console.log('  盲区来源拆分: 寿命截断型=' + cnt(blindRows, (r) => !isFull(r)) + ' 满窗口型=' + cnt(blindRows, isFull));
  console.log('--- 5. 轨迹"代"（abs0 变 = 一次重模拟/重锚）---');
  const gs = Object.keys(gen).map((k) => gen[k]);
  const gReal = gs.filter((g) => g.real0 === 1 && g.n >= 2);
  const gErr = gReal.filter((g) => num(g.lifeLeft0)).map((g) => r4(g.cover0 - g.lifeLeft0));
  const gShort = gReal.filter((g) => g.cover0 < 8.0);
  console.log('  代总数=' + gs.length + ' 首帧真弹还在且n>=2的=' + gReal.length + ' 其中 cover0<8s 的短代=' + gShort.length);
  console.log('  代首帧 err=cover0−lifeLeft0: n=' + gErr.length + ' min=' + r4(pct(gErr, 0)) + ' med=' + r4(pct(gErr, .5)) + ' p90=' + r4(pct(gErr, .9)) + ' max=' + r4(pct(gErr, 1)) + ' |err|<=1帧=' + cnt(gErr, (e) => Math.abs(e) <= 0.017) + '/' + gErr.length);
  console.log('  短代里 lifeLeft0<8s 的=' + cnt(gShort, (g) => num(g.lifeLeft0) && g.lifeLeft0 < 8) + '/' + gShort.length);
  const ex = (g) => JSON.stringify({ id: g.id, t0: g.t0, len0: g.len0, cover0: r4(g.cover0), lifeLeft0: r4(g.lifeLeft0), type: g.type, nB0: g.nB0, stopped0: g.stopped0, n: g.n, deltaMax: r4(g.deltaMax), minLen: g.minLen, minLifeLeft: r4(g.minLifeLeft), lastT: r3(g.lastT) });
  console.log('  样例·真弹代(前3):'); for (const g of gReal.slice(0, 3)) console.log('    ' + ex(g));
  console.log('  样例·短代(前5):'); for (const g of gShort.slice(0, 5)) console.log('    ' + ex(g));
  console.log('  样例·假绿候选行(前3):');
  for (const rr of nnra.slice(0, 3)) console.log('    ' + JSON.stringify({ t: r3(rr.t), id: rr.id, delta: r4(rr.delta), len: rr.len, tdt: rr.tdt, cover: r4(rr.cover), idxNow: rr.idxNow, lifeTotal: rr.lifeTotal, lifeAge: r4(rr.lifeAge), lifeLeft: r4(rr.lifeLeft), done: rr.done, stopped: rr.stopped, nB: rr.nB }));
  const byId = {};
  for (const r of nnra) { const o = byId[r.id] = byId[r.id] || { n: 0, covMax: 0, dMin: 1e9, dMax: 0, lifeLeftMin: null };
    o.n++; if (r.cover > o.covMax) o.covMax = r.cover; if (r.delta < o.dMin) o.dMin = r.delta; if (r.delta > o.dMax) o.dMax = r.delta;
    if (num(r.lifeLeft) && (o.lifeLeftMin === null || r.lifeLeft < o.lifeLeftMin)) o.lifeLeftMin = r.lifeLeft; }
  console.log('  假绿候选逐 id:');
  for (const id of Object.keys(byId).slice(0, 8)) { const o = byId[id];
    console.log('    ' + String(id).padEnd(14) + ' n=' + o.n + ' coverMax=' + r4(o.covMax) + ' Δ=' + r4(o.dMin) + '~' + r4(o.dMax) + ' lifeLeftMin=' + r4(o.lifeLeftMin)); }
  console.log('wallMs=' + (Date.now() - t0));
})();
