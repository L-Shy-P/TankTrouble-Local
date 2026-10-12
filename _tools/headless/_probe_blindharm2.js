'use strict';
/* 只读探针 v2（盲区危害判定，2026-10-12）。不改 game_core 一个字节。
 * 关键修正：只看 tick 帧（树不被冻结），并把"树时钟 vs 真游戏时钟"作为一等量测。
 * 口径：dumpDiagnostics().liveAnchors[]（AGENTS 2026-10-12 定）。
 * 输出：
 *   ①时钟比 ratio = Δ / 真游戏已过秒（同一条"轨迹代"内）——判"树秒=游戏秒"吗
 *   ②取位 null_now × 真弹还活着（=树看不见活弹 ⇒ 假绿候选），只在 tick 帧
 *   ③深节点越界(盲区)：按 ratio 把树 horizon 换算成游戏秒，判"越界时弹是否已真的死"
 *   ④每颗弹：真死事件 vs null_now 事件的先后
 * 用法: node _tools/headless/_probe_blindharm2.js --frames=900 --tag=B1
 */
const { Match } = require('./match');

const PAGE_SRC = `(() => {
  if (window.__bh2) return 'exists';
  window.__bh2 = function () {
    var out = { ok: false };
    try {
      var d = VantageTree.dumpDiagnostics();
      var t = VantageTree.getTree ? VantageTree.getTree() : null;
      if (!d || !t) return { ok: false, why: 'no-tree' };
      var gc = (typeof GameManager !== 'undefined' && GameManager.getGameController) ? GameManager.getGameController() : null;
      var proj = (gc && gc.getProjectiles) ? gc.getProjectiles() : null;
      var deepest = 0, ends = [];
      try { t.walk(function (n) { if (n && typeof n.tEndSec === 'number') { if (n.tEndSec > deepest) deepest = n.tEndSec; if (n !== t.root) ends.push(Math.round(n.tEndSec * 1000) / 1000); } }); } catch (e2) {}
      out.ok = true; out.ver = VantageTree.VERSION || null;
      out.t = d.tNow; out.deepest = deepest;
      out.tacc = (VantageTree._coarse && VantageTree._coarse.getTimeAcc) ? VantageTree._coarse.getTimeAcc() : null;
      out.need = (t.diag && typeof t.diag.trackFrames === 'number') ? t.diag.trackFrames : null;
      out.ticking = !!(t.diag && typeof t.diag.lastCheckAt === 'number' && Math.abs(t.diag.lastCheckAt - d.tNow) < 1e-9);
      out.liveProj = d.liveProjectileCount; out.ends = ends;
      out.rows = (d.liveAnchors || []).map(function (a) {
        var tdt = (a.trackDt && a.trackDt > 0) ? a.trackDt : 0.0166666667;
        var cover = (a.trackLen || 0) * tdt;
        var pr = (proj && a.id !== undefined && proj.hasOwnProperty(a.id)) ? proj[a.id] : null;
        var o = { id: a.id, delta: a.delta, len: a.trackLen || 0, tdt: tdt, cover: cover, abs0: a.abs0, hasTrack: a.hasTrack ? 1 : 0, real: pr ? 1 : 0 };
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
const pct = (a, p) => { if (!a.length) return null; const b = a.slice().sort((x, y) => x - y); return r4(b[Math.min(b.length - 1, Math.max(0, Math.floor(p * b.length)))]); };
const cnt = (a, f) => a.filter(f).length;
const num = (v) => typeof v === 'number' && isFinite(v);

(async () => {
  const frames = Number((process.argv.find((a) => a.startsWith('--frames=')) || '').split('=')[1] || 900);
  const tags = (process.argv.find((a) => a.startsWith('--tag=')) || '--tag=B').split('=')[1];
  const vant = Number((process.argv.find((a) => a.startsWith('--vant=')) || '--vant=2').split('=')[1] || 2);
  const m = new Match();
  const t0 = Date.now();
  const all = [];
  for (const tag of tags.split(',')) {
    let framesOk = 0, tickFrames = 0, maxNodes = 0, needRef = null, ver = null;
    const rows = [], gen = {};
    try {
      await m.open({ humanIds: ['tank_a'], aiCount: 1, vantCount: vant });
      await m.eval(PAGE_SRC);
      for (let f = 0; f < frames; f++) {
        if (true) {
          const rot = f * 0.6;
          await m.eval(`(() => { var gc = GameManager.getGameController(); var a = gc.getTank ? gc.getTank('tank_a') : null;
            if (a && gc.setTankState) gc.setTankState(TankState.withState('tank_a', a.getX(), a.getY(), false,false, ${rot}, false,false,false,false), false);
            window.__vtCtrl.fire = true; return 1; })()`);
        }
        await m.pump(1);
        const s = await m.eval('window.__bh2()').catch(() => null);
        if (!s || !s.ok) continue;
        framesOk++;
        if (ver === null) ver = s.ver;
        if (needRef === null && num(s.need)) needRef = s.need;
        if (s.ticking) tickFrames++;
        if ((s.ends || []).length > maxNodes) maxNodes = s.ends.length;
        const ends = s.ends || [];
        if (!s.ticking) continue;                       // ★ 只留 tick 帧（树没冻结）
        for (const rr of (s.rows || [])) {
          let blind = 0;
          for (let i = 0; i < ends.length; i++) if ((ends[i] - s.t) + rr.delta > rr.cover) blind++;
          const row = Object.assign({ run: tag, f, t: s.t, tacc: s.tacc, horizon: r4(s.deepest - s.t), need: s.need, blind, nodes: ends.length }, rr);
          rows.push(row);
          const gk = String(rr.id) + '@' + r3(rr.abs0);
          let g = gen[gk];
          if (!g) { g = gen[gk] = { seq: Object.keys(gen).length + 1, id: rr.id, abs0: r3(rr.abs0), f0: f, t0: r3(s.t), n: 0, len0: rr.len, cover0: r4(rr.cover), need0: s.need, lifeLeft0: rr.lifeLeft, lifeAge0: rr.lifeAge, real0: rr.real, type: rr.type, nB0: rr.nB, stopped0: rr.stopped, deltaFirst: rr.delta, deltaMax: 0, lifeAgeFirst: rr.lifeAge, lifeAgeLast: null, minLen: 1e9, fLast: f, realSeen: 0 }; }
          g.n++;
          if (rr.delta > g.deltaMax) g.deltaMax = rr.delta;
          if (rr.len < g.minLen) g.minLen = rr.len;
          if (num(rr.lifeAge)) g.lifeAgeLast = rr.lifeAge;
          if (rr.real === 1) g.realSeen++;
          if (f > g.fLast) g.fLast = f;
        }
      }
      await m.clearControl();
    } catch (e) { console.error('FAILED[' + tag + ']:', (e && e.stack) || e); process.exitCode = 1; }
    finally { try { await m.close(); } catch (e) {} }
    all.push({ tag, framesOk, tickFrames, maxNodes, needRef, ver, rows, gen });
  }

  console.log('=== 盲区危害判定探针v2 [' + all.map((a) => a.tag).join(',') + '] VERSION=' + (all.length ? all[0].ver : '') + ' ===');
  for (const A of all) {
    console.log('-- run ' + A.tag + ': 帧=' + frames + ' 有效帧=' + A.framesOk + ' tick帧=' + A.tickFrames + ' 节点数最大=' + A.maxNodes + ' needFrames首值=' + A.needRef + ' tick样本行=' + A.rows.length);
  }
  const rows = [].concat(...all.map((a) => a.rows));
  const gs = [].concat(...all.map((a) => Object.keys(a.gen).map((k) => a.gen[k])));
  if (!rows.length) { console.log('（没有 tick 样本，终止）'); return; }

  // ① 时钟比 = Δ / 真游戏已过秒（同一轨迹代内）
  const ratios = [];
  for (const g of gs) {
    if (g.realSeen < 3 || !num(g.lifeAgeLast) || !num(g.lifeAge0)) continue;
    const dg = g.lifeAgeLast - g.lifeAge0, dd = g.deltaMax - g.deltaFirst;
    if (dg > 0.05 && dd > 0.05) ratios.push({ r: dd / dg, id: g.id, n: g.n, dg: dg, dd: dd });
  }
  const rv = ratios.map((x) => x.r);
  console.log('--- ① 时钟比 ratio = Δ(树秒) / 真游戏已过秒（同代内，n>=3，两侧增量>0.05s）---');
  console.log('  样本代=' + rv.length + ' min=' + pct(rv, 0) + ' p25=' + pct(rv, .25) + ' med=' + pct(rv, .5) + ' p75=' + pct(rv, .75) + ' max=' + pct(rv, 1));
  console.log('  ratio∈[0.9,1.1] 的代=' + cnt(rv, (r) => r >= 0.9 && r <= 1.1) + '/' + rv.length + '  ratio≈2 的代=' + cnt(rv, (r) => r > 1.7 && r < 2.3));
  const taccSpan = (() => { const a = rows.filter((r) => num(r.tacc)); if (!a.length) return null; return { t: r4(Math.max.apply(null, a.map((x) => x.tacc)) - Math.min.apply(null, a.map((x) => x.tacc))), f: Math.max.apply(null, a.map((x) => x.f)) - Math.min.apply(null, a.map((x) => x.f)) }; })();
  if (taccSpan) console.log('  树绝对钟 _timeAcc 跨度=' + taccSpan.t + 's / 泵帧跨度=' + taccSpan.f + ' → ' + r4(taccSpan.t / Math.max(1, taccSpan.f)) + ' 树秒每泵帧（游戏每泵帧=0.01667s）');

  // ② 取位 null_now × 真弹活着
  const isFull = (r) => num(r.need) && r.len >= r.need;
  const nullNow = (r) => (r.hasTrack ? (r.idxNow === undefined ? (Math.round(r.delta / r.tdt) >= r.len) : (r.idxNow >= r.len)) : true);
  const realAlive = (r) => (r.real === 1 && r.done !== 1);
  const cross = { nn_ra: 0, nn_rd: 0, nn_noreal: 0, ok_ra: 0, ok_rd: 0, ok_noreal: 0 };
  for (const r of rows) { const n = nullNow(r), a = realAlive(r);
    if (n && a) cross.nn_ra++; else if (n && r.real === 1) cross.nn_rd++; else if (n) cross.nn_noreal++;
    else if (a) cross.ok_ra++; else if (r.real === 1) cross.ok_rd++; else cross.ok_noreal++; }
  const nnra = rows.filter((r) => nullNow(r) && realAlive(r));
  console.log('--- ② 取位 null_now × 真游戏弹状态（只 tick 帧，n=' + rows.length + '）---');
  console.log('  null_now & 真弹活着(假绿候选)=' + cross.nn_ra + ' | null_now & 真弹done=' + cross.nn_rd + ' | null_now & 弹不存在=' + cross.nn_noreal);
  console.log('  取位正常 & 真弹活着=' + cross.ok_ra + ' | 取位正常 & 真弹done=' + cross.ok_rd + ' | 取位正常 & 弹不存在=' + cross.ok_noreal);
  console.log('  假绿候选里 寿命截断型=' + cnt(nnra, (r) => !isFull(r)) + ' 满窗口型=' + cnt(nnra, isFull));
  console.log('  全样本里 len<need(截断型)=' + cnt(rows, (r) => !isFull(r)) + '/' + rows.length + '  null_now 总行=' + cnt(rows, nullNow));
  const early = rows.filter((r) => !isFull(r) && num(r.lifeLeft) && r.real === 1 && (r.cover - r.delta - r.lifeLeft) < -0.034);
  if (early.length) { console.log('  ★早期截断行(=轨迹末端比真弹死得早>2帧) n=' + early.length + '  逐行样例:'); for (const r of early.slice(0, 5)) console.log('    ' + JSON.stringify({ run: r.run, f: r.f, id: r.id, len: r.len, tdt: r.tdt, cover: r4(r.cover), delta: r4(r.delta), lifeLeft: r4(r.lifeLeft), lifeAge: r4(r.lifeAge), horizon: r.horizon, nB: r.nB, stopped: r.stopped })); }
  const shortRows = rows.filter((r) => !isFull(r));
  const errRow = shortRows.filter((r) => num(r.lifeLeft) && r.real === 1).map((r) => r4(r.cover - r.delta - r.lifeLeft));
  console.log('  ★短轨迹行 err=cover−Δ−真弹剩余寿命: n=' + errRow.length + ' min=' + pct(errRow, 0) + ' p10=' + pct(errRow, .1) + ' med=' + pct(errRow, .5) + ' p90=' + pct(errRow, .9) + ' max=' + pct(errRow, 1) +
    ' | 提前(<-2帧 ⇒ 轨迹比真弹死得早=假绿方向)=' + cnt(errRow, (e) => e < -0.034) + ' 滞后(>+2帧=假红方向)=' + cnt(errRow, (e) => e > 0.034));
  const covAll = rows.map((r) => r.cover);
  console.log('  覆盖 cover 分布: min=' + pct(covAll, 0) + ' p10=' + pct(covAll, .1) + ' med=' + pct(covAll, .5) + ' max=' + pct(covAll, 1) + '  cover<1s 行=' + cnt(covAll, (c) => c < 1) + ' cover<0.3s 行=' + cnt(covAll, (c) => c < 0.3) + ' cover<8.2s 行=' + cnt(covAll, (c) => c < 8.2));
  const hz = rows.map((r) => r.horizon);
  console.log('  深节点 horizon(树秒) 分布: min=' + pct(hz, 0) + ' med=' + pct(hz, .5) + ' p90=' + pct(hz, .9) + ' max=' + pct(hz, 1));

  // ③ 盲区
  const blindRows = rows.filter((r) => r.blind > 0);
  const ratioMed = pct(rv, .5) || 1;
  console.log('--- ③ 深节点越界(盲区)（只 tick 帧）---');
  console.log('  盲区行=' + blindRows.length + '/' + rows.length + ' (' + r3(100 * blindRows.length / rows.length) + '%)  单行盲区节点数最大=' + (blindRows.length ? Math.max.apply(null, blindRows.map((r) => r.blind)) : 0));
  console.log('  盲区来源: 寿命截断型=' + cnt(blindRows, (r) => !isFull(r)) + ' 满窗口型=' + cnt(blindRows, isFull));
  console.log('  盲区行 cover 分布: min=' + pct(blindRows.map((r) => r.cover), 0) + ' med=' + pct(blindRows.map((r) => r.cover), .5) + ' max=' + pct(blindRows.map((r) => r.cover), 1));
  console.log('  盲区行 Δ 分布: min=' + pct(blindRows.map((r) => r.delta), 0) + ' med=' + pct(blindRows.map((r) => r.delta), .5) + ' max=' + pct(blindRows.map((r) => r.delta), 1) + '  horizon med=' + pct(blindRows.map((r) => r.horizon), .5));
  const bl = blindRows.filter((r) => num(r.lifeLeft) && r.real === 1);
  // 越界⇔"深节点在弹死之后"：游戏秒 = 树 horizon / ratio；真弹剩余 = lifeLeft(游戏秒)
  const gameAhead = bl.map((r) => r4(r.horizon / ratioMed));
  const pairs = bl.map((r, i) => ({ ahead: r.horizon / ratioMed, left: r.lifeLeft }));
  const bad = bl.filter((r) => ((r.delta + r.horizon) / ratioMed) < r.lifeLeft);
  const badErr = bad.filter((r) => num(r.lifeLeft)).map((r) => r4(r.cover - r.delta - r.lifeLeft));
  const badNB = bad.reduce((a, r) => { a['nB' + (r.nB || 0)] = (a['nB' + (r.nB || 0)] || 0) + 1; return a; }, {});
  console.log('  ⚠"越界但真弹还没死"行=' + bad.length + ' 其 err=cover−Δ−生活着秒: med=' + pct(badErr, .5) + ' min=' + pct(badErr, 0) + ' 反弹记录分布=' + JSON.stringify(badNB) + ' stopped=' + cnt(bad, (r) => r.stopped === 1) + ' 类型=' + JSON.stringify(bad.reduce((a, r) => { a[r.type] = (a[r.type] || 0) + 1; return a; }, {})));
  console.log('  ⚠样例(前 3):'); for (const r of bad.slice(0, 3)) console.log('    ' + JSON.stringify({ run: r.run, f: r.f, id: r.id, delta: r4(r.delta), len: r.len, tdt: r.tdt, cover: r4(r.cover), horizon: r.horizon, ahead: r4(r.horizon / ratioMed), lifeLeft: r4(r.lifeLeft), lifeAge: r4(r.lifeAge), nB: r.nB, stopped: r.stopped, type: r.type }));
  console.log('  盲区行里 真弹还在(real=1,未done)=' + cnt(blindRows, realAlive) + '/' + blindRows.length +
    ' | 真弹剩余寿命 med=' + pct(bl.map((r) => r.lifeLeft), .5) + ' min=' + pct(bl.map((r) => r.lifeLeft), 0));
  const aheadD = bl.map((r) => (r.delta + r.horizon) / ratioMed);
  const pairsD = bl.map((r, i) => ({ ahead: aheadD[i], left: r.lifeLeft, short: r.lifeLeft - aheadD[i] }));
  console.log('  [判据·按 ratio 换算成真游戏秒，含 Δ] 越界时刻超过剩余寿命(⇒弹必已死 ⇒ 盲区无害)=' + cnt(pairsD, (p) => p.ahead >= p.left) + '/' + pairsD.length +
    '  反向(越界却在寿命内 ⇒ 危险)=' + cnt(pairsD, (p) => p.ahead < p.left) + '  反向里不足<=2帧的=' + cnt(pairsD, (p) => p.ahead < p.left && p.short <= 0.034) + ' 不足>2帧的=' + cnt(pairsD, (p) => p.ahead < p.left && p.short > 0.034));
  const vals = pairsD.map((p) => r4(p.ahead - p.left));
  console.log('    (越界时刻 − 剩余寿命) med=' + pct(vals, .5) + ' min=' + pct(vals, 0) + ' max=' + pct(vals, 1) + '  < −2帧的行=' + cnt(vals, (v) => v < -0.034));
  const idxDeep = bl.map((r) => (r.delta + r.horizon) / r.tdt);
  console.log('  [判据·按轨迹自己的帧时基] 深节点查询下标 idx=(Δ+horizon)/tdt: med=' + pct(idxDeep.map((x) => r4(x)), .5) + ' vs 该行 len med=' + pct(bl.map((r) => r.len), .5) + '（越界定义保证 idx>=len）  超出末端的树秒 med=' + pct(bl.map((r) => r4(r.delta + r.horizon - r.cover)), .5));
  console.log('  换算用 ratio(med)=' + r4(ratioMed) + '；ahead med=' + pct(pairs.map((p) => p.ahead), .5) + ' left med=' + pct(pairs.map((p) => p.left), .5));

  // ④ 每颗弹：真死事件 vs null_now 事件
  const byId = {};
  for (const r of rows) { const o = byId[r.id] = byId[r.id] || { n: 0, realAliveN: 0, realSeenN: 0, nullN: 0, nullFirstF: null, deadFirstF: null, deltaMax: 0, covMin: 1e9, covMax: 0, lifeLeftMin: null };
    o.n++; if (realAlive(r)) { o.realAliveN++; if (o.deadFirstF === null) o.deadFirstF = r.f; }
    if (r.real === 1) o.realSeenN++;
    if (nullNow(r)) { o.nullN++; if (o.nullFirstF === null) o.nullFirstF = r.f; }
    if (r.delta > o.deltaMax) o.deltaMax = r.delta;
    if (r.cover < o.covMin) o.covMin = r.cover; if (r.cover > o.covMax) o.covMax = r.cover;
    if (num(r.lifeLeft) && (o.lifeLeftMin === null || r.lifeLeft < o.lifeLeftMin)) o.lifeLeftMin = r.lifeLeft; }
  console.log('--- ④ 逐弹（只 tick 帧）---');
  for (const id of Object.keys(byId)) { const o = byId[id];
    console.log('  ' + String(id).padEnd(14) + ' 行=' + String(o.n).padStart(4) + ' 活帧=' + String(o.realAliveN).padStart(4) + ' null帧=' + String(o.nullN).padStart(4) +
      ' null首帧f=' + o.nullFirstF + ' Δmax=' + r4(o.deltaMax) + ' cover=' + r4(o.covMin) + '~' + r4(o.covMax) + ' lifeLeftMin=' + r4(o.lifeLeftMin)); }
  console.log('--- ⑤ 轨迹代（abs0 变）结构 ---');
  const gReal = gs.filter((g) => g.realSeen >= 3);
  const gErr = gReal.filter((g) => num(g.lifeLeft0)).map((g) => r4(g.cover0 - g.lifeLeft0));
  console.log('  代总数=' + gs.length + ' 活跃代(realSeen>=3)=' + gReal.length);
  console.log('  代首帧 err=cover0−lifeLeft0: n=' + gErr.length + ' min=' + pct(gErr, 0) + ' med=' + pct(gErr, .5) + ' p90=' + pct(gErr, .9) + ' max=' + pct(gErr, 1) + ' |err|<=2帧=' + cnt(gErr, (e) => Math.abs(e) <= 0.034) + '/' + gErr.length);
  const ex0 = (g) => JSON.stringify({ id: g.id, t0: g.t0, len0: g.len0, cover0: r4(g.cover0), lifeLeft0: r4(g.lifeLeft0), lifeAge0: r4(g.lifeAge0), deltaFirst: r4(g.deltaFirst), type: g.type, nB0: g.nB0, stopped0: g.stopped0, n: g.n, f0: g.f0 });
  const gEarly = gReal.filter((g) => num(g.lifeLeft0) && (g.cover0 - g.lifeLeft0) < -0.034);
  console.log('  ★早死代(cover0−lifeLeft1 小于 −2帧=模型判死比真游戏早)=' + gEarly.length + '/' + gReal.length +
    '  nB0>=5 的=' + cnt(gEarly, (g) => g.nB0 >= 5) + '  nB0=1~4 的=' + cnt(gEarly, (g) => g.nB0 >= 1 && g.nB0 < 5) + ' nB0=0 的=' + cnt(gEarly, (g) => !g.nB0) +
    '  stopped=' + cnt(gEarly, (g) => g.stopped0 === 1) + ' | 提前秒 med=' + pct(gEarly.map((g) => r4(g.cover0 - g.lifeLeft0)), .5) + ' min=' + pct(gEarly.map((g) => r4(g.cover0 - g.lifeLeft0)), 0));
  for (const g of gEarly.slice(0, 6)) console.log('    早死代样例 ' + ex0(g));
  const gShortAll = gReal.filter((g) => g.len0 < (g.need0 || 1e9) || g.cover0 < 8.0);
  const gsErr = gShortAll.map((g) => r4(g.cover0 - g.lifeLeft0));
  console.log('  ★"短代"(len0<need0 或 cover0<8s) n=' + gShortAll.length + ' err0=cover0−lifeLeft0: min=' + pct(gsErr, 0) + ' p10=' + pct(gsErr, .1) + ' med=' + pct(gsErr, .5) + ' max=' + pct(gsErr, 1) + '  早期截断(err0<−2帧)=' + cnt(gsErr, (e) => e < -0.034) + '  晚期窗口截断(err0>2帧)=' + cnt(gsErr, (e) => e > 0.034));
  for (const g of gShortAll.filter((g) => (g.cover0 - g.lifeLeft0) < -0.034).slice(0, 6)) console.log('    早期截断代 ' + ex0(g));
  const earlyRows = errRow.length ? null : null;
  const gShort = gReal.filter((g) => g.cover0 < 8.0);
  console.log('  短代(cover0<8s)=' + gShort.length + ' 其中 lifeLeft0<8s=' + cnt(gShort, (g) => num(g.lifeLeft0) && g.lifeLeft0 < 8) + '  类型分布=' + JSON.stringify(gShort.reduce((a, g) => { a[g.type] = (a[g.type] || 0) + 1; return a; }, {})) +
    '  有反弹记录(nB0>0)=' + cnt(gShort, (g) => g.nB0 > 0) + ' stopped=' + cnt(gShort, (g) => g.stopped0 === 1));
  console.log('  全部代类型分布=' + JSON.stringify(gReal.reduce((a, g) => { a[g.type] = (a[g.type] || 0) + 1; return a; }, {})));
  const ex = (g) => JSON.stringify({ id: g.id, t0: g.t0, len0: g.len0, cover0: r4(g.cover0), lifeLeft0: r4(g.lifeLeft0), type: g.type, nB0: g.nB0, stopped0: g.stopped0, n: g.n, minLen: g.minLen, deltaMax: r4(g.deltaMax), f0: g.f0, fLast: g.fLast });
  console.log('  样例·短代(前 6):'); for (const g of gShort.slice(0, 6)) console.log('    ' + ex(g));
  console.log('  样例·假绿候选行(前 4):');
  for (const rr of nnra.slice(0, 4)) console.log('    ' + JSON.stringify({ run: rr.run, f: rr.f, id: rr.id, delta: r4(rr.delta), len: rr.len, tdt: rr.tdt, cover: r4(rr.cover), idxNow: Math.round(rr.delta / rr.tdt), lifeTotal: rr.lifeTotal, lifeAge: r4(rr.lifeAge), lifeLeft: r4(rr.lifeLeft), done: rr.done, stopped: rr.stopped, nB: rr.nB }));
  console.log('wallMs=' + (Date.now() - t0));
})();
