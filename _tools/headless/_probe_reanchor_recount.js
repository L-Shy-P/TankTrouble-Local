'use strict';
/* 只读探针（重锚门收益复核用，v169 版）：
 *   【旧口径】= t.diag.anchorProbe 快照行（上一轮 _probe_reanchor_fix.js 的读法；diagFresh = lastCheckAt===tNow）
 *       其中再拆：probeFresh = anchorProbeAt===tNow（本帧真重建）；否则 = 空弹窗口早退的陈旧快照
 *   【新口径】= dumpDiagnostics().liveAnchors（实时现算 Δ，不经快照）
 * getTree() 返回视图【无 threats】；活锚点只能走 dumpDiagnostics().liveAnchors（踩过）。
 * 用法: node _tools/headless/_probe_reanchor_recount.js --frames=900 --tag=xxx
 */
const { Match } = require('./match');

const PAGE_SRC = `(() => {
  if (window.__rr) return 'exists';
  window.__rr = function () {
    var out = { ok: false };
    try {
      var d = VantageTree.dumpDiagnostics();
      var t = VantageTree.getTree ? VantageTree.getTree() : null;
      if (!d || !t) return { ok: false, why: 'no-tree' };
      out.ok = true; out.ver = VantageTree.VERSION || null;
      out.t = d.tNow; out.rootAbsT = d.rootAbsT;
      out.probeAt = (t.diag && typeof t.diag.anchorProbeAt === 'number') ? t.diag.anchorProbeAt : null;
      out.lastCheckAt = (t.diag && typeof t.diag.lastCheckAt === 'number') ? t.diag.lastCheckAt : null;
      out.age = (typeof d.anchorProbeAge === 'number') ? d.anchorProbeAge : null;
      out.needFrames = (t.diag && typeof t.diag.trackFrames === 'number') ? t.diag.trackFrames : null;
      var ends = [];
      try { t.walk(function (n) { if (n && n !== t.root && typeof n.tEndSec === 'number') ends.push(Math.round(n.tEndSec * 1000) / 1000); }); } catch (e2) {}
      out.ends = ends;
      out.liveThreats = (d.liveAnchors || []).map(function (th) {
        return { id: th.id, abs0: th.abs0, delta: th.delta, len: th.trackLen || 0,
                 tdt: (th.trackDt && th.trackDt > 0) ? th.trackDt : 0.0166666667,
                 anchorOffset: th.anchorOffset, hasTrack: th.hasTrack };
      });
      out.snap = ((t.diag && t.diag.anchorProbe) || []).map(function (a) {
        return { id: a.id, abs0: a.abs0, len: a.len, tdt: a.tdt, px: a.px, py: a.py, rx: a.rx, ry: a.ry };
      });
      return out;
    } catch (e) { out.err = String((e && e.message) || e); return out; }
  };
  return 'ok';
})()`;

function pct(a, p) { a = a.slice().sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.max(0, Math.floor(p * a.length)))]; }
const r3 = (x) => (typeof x === 'number' ? Math.round(x * 1000) / 1000 : x);

function stats(rows) {
  const D = [];
  let over1 = 0, overCover = 0, nullN = 0, blind = 0, blindSum = 0, maxBlind = 0;
  for (const r of rows) {
    D.push(r.d);
    if (r.d > 1.0) over1++;
    if (r.d > r.cover) overCover++;
    if (r.pxNull) nullN++;
    if (r.blind > 0) { blind++; blindSum += r.blind; if (r.blind > maxBlind) maxBlind = r.blind; }
  }
  return { n: D.length, dmin: D.length ? r3(pct(D, 0)) : null, dmed: D.length ? r3(pct(D, .5)) : null,
           dp90: D.length ? r3(pct(D, .9)) : null, dp99: D.length ? r3(pct(D, .99)) : null, dmax: D.length ? r3(pct(D, 1)) : null,
           over1, overCover, nullN, blindN: blind, blindPct: D.length ? Math.round(1000 * blind / D.length) / 10 : null, blindMax: maxBlind };
}
const line = (name, s) => '  ' + name.padEnd(16) + ' n=' + String(s.n).padStart(6) +
  ' Dmin=' + String(s.dmin).padStart(6) + ' med=' + String(s.dmed).padStart(6) + ' p90=' + String(s.dp90).padStart(6) +
  ' p99=' + String(s.dp99).padStart(6) + ' max=' + String(s.dmax).padStart(7) +
  ' | D>1=' + String(s.over1).padStart(4) + ' D>cover=' + String(s.overCover).padStart(4) + ' null=' + String(s.nullN).padStart(4) +
  ' 盲区=' + String(s.blindN).padStart(4) + '(' + s.blindPct + '%) 盲区最大=' + s.blindMax;

function rowsFromSnap(s, ends) {
  const out = [];
  const ticking = (s.lastCheckAt !== null && Math.abs(s.lastCheckAt - s.t) < 1e-9);
  const probeFresh = ticking && s.probeAt !== null && Math.abs(s.probeAt - s.t) < 1e-9;
  for (const a of (s.snap || [])) {
    const d = s.t - a.abs0, cover = (a.len || 0) * (a.tdt || 0.0166667);
    let blind = 0;
    for (let i = 0; i < ends.length; i++) if ((ends[i] - s.t) + d > cover) blind++;
    out.push({ t: s.t, id: a.id, d, cover, len: a.len || 0, tdt: a.tdt, need: s.needFrames,
               pxNull: (a.px === null || a.px === undefined), blind, n: ends.length,
               ticking, probeFresh, hasRx: (a.rx !== null && a.rx !== undefined) });
  }
  return { rows: out, ticking, probeFresh };
}
function rowsFromLive(s, ends) {
  const ticking = (s.lastCheckAt !== null && Math.abs(s.lastCheckAt - s.t) < 1e-9);
  const probeFresh = ticking && s.probeAt !== null && Math.abs(s.probeAt - s.t) < 1e-9;
  const out = [];
  for (const th of (s.liveThreats || [])) {
    const d = th.delta, cover = (th.len || 0) * (th.tdt || 0.0166667), td = th.tdt || 0.0166667;
    let blind = 0;
    for (let i = 0; i < ends.length; i++) if ((ends[i] - s.t) + d > cover) blind++;
    out.push({ t: s.t, id: th.id, d, cover, len: th.len, tdt: td, need: s.needFrames, blind,
               pxNull: (th.hasTrack && th.len > 0) ? (Math.round(d / td) >= th.len) : true,
               ticking, probeFresh, full: (s.needFrames && th.len >= s.needFrames) ? 1 : 0 });
  }
  return out;
}

(async () => {
  const frames = Number((process.argv.find((a) => a.startsWith('--frames=')) || '').split('=')[1] || 900);
  const tag = (process.argv.find((a) => a.startsWith('--tag=')) || '--tag=?').split('=')[1];
  const m = new Match();
  const t0 = Date.now();
  try {
    await m.open({ humanIds: ['tank_a'], aiCount: 1, vantCount: 2 });
    await m.eval(PAGE_SRC);
    let ver = null, tickFrames = 0, frozenFrames = 0, emptyWin = 0, maxRun = 0, curRun = 0, maxNodes = 0, maxAge = 0, agePos = 0;
    let absMismatch = 0, maxAbsDiff = 0, firstLiveEx = null;
    const cn = []; let lastRoot = null;
    const snapRows = [], liveRows = [];
    for (let f = 0; f < frames; f++) {
      if (f % 40 === 0) {
        const rot = (f / 40) * 0.35;
        await m.eval(`(() => { var gc = GameManager.getGameController(); var a = gc.getTank ? gc.getTank('tank_a') : null;
          if (a && gc.setTankState) gc.setTankState(TankState.withState('tank_a', a.getX(), a.getY(), false,false, ${rot}, false,false,false,false), false);
          window.__vtCtrl.fire = true; return 1; })()`);
      }
      await m.pump(1);
      const s = await m.eval('window.__rr()').catch(() => null);
      if (!s || !s.ok) continue;
      if (ver === null) ver = s.ver;
      if (lastRoot !== null && Math.abs(s.rootAbsT - lastRoot) > 1e-6) cn.push(Math.round((s.rootAbsT - lastRoot) * 1000) / 1000);
      lastRoot = s.rootAbsT;
      const ends = s.ends || [];
      if (ends.length > maxNodes) maxNodes = ends.length;
      const A = rowsFromSnap(s, ends), B = rowsFromLive(s, ends);
      snapRows.push(...A.rows); liveRows.push(...B);
      if (typeof s.age === 'number' && s.age > 0) { agePos++; if (s.age > maxAge) maxAge = s.age; }
      if (A.ticking) tickFrames++; else frozenFrames++;
      if (A.ticking && !A.probeFresh) { emptyWin++; curRun++; if (curRun > maxRun) maxRun = curRun; } else curRun = 0;
      if (A.probeFresh) {
        const lm = {}; for (const th of (s.liveThreats || [])) lm[th.id] = th;
        for (const a of (s.snap || [])) { const lv = lm[a.id]; if (!lv) continue;
          const diff = Math.abs((a.abs0 || 0) - lv.abs0); if (diff > 1e-6) absMismatch++; if (diff > maxAbsDiff) maxAbsDiff = r3(diff); }
      }
      if (!firstLiveEx && B.length) firstLiveEx = { t: s.t, rootAbsT: s.rootAbsT, liveAnchors: (s.liveThreats || []).slice(0, 3) };
    }
    await m.clearControl();
    const oldB = snapRows.filter((r) => r.ticking);
    const oldF = snapRows.filter((r) => r.ticking && r.probeFresh);
    const oldS = snapRows.filter((r) => r.ticking && !r.probeFresh);
    const frozen = snapRows.filter((r) => !r.ticking);
    const newT = liveRows.filter((r) => r.ticking);
    console.log('=== 重锚门收益复核 recount [' + tag + '] VERSION=' + ver + ' ===');
    console.log('帧=' + frames + ' tick帧=' + tickFrames + ' 冻结/未tick帧=' + frozenFrames + ' 空弹窗口帧=' + emptyWin +
      ' 最长连续=' + maxRun + ' 节点数最大=' + maxNodes + ' anchorProbeAge>0帧=' + agePos + ' maxAge=' + maxAge.toFixed(3) + ' commit=' + cn.length + ' shift med=' + (cn.length ? pct(cn, .5) : '-') + ' max=' + (cn.length ? pct(cn, 1) : '-') + ' >1.0=' + cn.filter((c) => c > 1.0).length);
    console.log('快照-活锚点 abs0 不一致行=' + absMismatch + ' maxDiff=' + maxAbsDiff + '（只查 probeFresh 帧同 id）');
    console.log('Δ / 覆盖 / 取位 / 深节点盲区 对照：');
    console.log(line('旧口径(上一轮)', stats(oldB)));
    console.log(line('  本帧重建', stats(oldF)));
    console.log(line('  空弹窗口陈旧', stats(oldS)));
    console.log(line('冻结帧行', stats(frozen)));
    console.log(line('新口径(tick帧)', stats(newT)));
    console.log(line('新口径(全帧)', stats(liveRows)));
    const wRx = (rs) => rs.filter((r) => r.hasRx);
    console.log('复刻上一轮过滤(rx/ry非null)：旧口径 null=' + wRx(oldB).filter((r) => r.pxNull).length + '/' + wRx(oldB).length +
      '；本帧重建 null=' + wRx(oldF).filter((r) => r.pxNull).length + '/' + wRx(oldF).length +
      '；空弹窗口陈旧 null=' + wRx(oldS).filter((r) => r.pxNull).length + '/' + wRx(oldS).length);
    const full = (rs) => rs.filter((r) => r.need && r.len >= r.need);
    for (const nm of [['旧口径', oldB], ['  本帧重建', oldF], ['  空弹窗口陈旧', oldS], ['新口径tick帧', newT]]) {
      const rs = full(nm[1]);
      console.log('满窗口型(' + nm[0] + ') n=' + rs.length + ' Δmax=' + (rs.length ? r3(Math.max(...rs.map((r) => r.d))) : '-') +
        ' Δ>cover=' + rs.filter((r) => r.d > r.cover).length + ' null=' + rs.filter((r) => r.pxNull).length +
        ' 盲区=' + rs.filter((r) => r.blind > 0).length + '/' + rs.length);
    }
    const byId = {};
    for (const r of newT) { const o = byId[r.id] = byId[r.id] || { n: 0, dmax: 0, nullN: 0, fullN: 0, cover: 0, blind: 0 };
      o.n++; if (r.d > o.dmax) o.dmax = r.d; if (r.pxNull) o.nullN++; if (r.full) o.fullN++; if (r.cover > o.cover) o.cover = r.cover; if (r.blind > 0) o.blind++; }
    console.log('逐弹（新口径 tick 帧）：');
    for (const id of Object.keys(byId).sort((a, b) => byId[b].dmax - byId[a].dmax).slice(0, 6)) {
      const o = byId[id];
      console.log('   ' + String(id).padEnd(14) + ' n=' + String(o.n).padStart(5) + ' Δmax=' + r3(o.dmax).toFixed(3) + ' coverMax=' + r3(o.cover).toFixed(2) +
        ' 满窗口样本=' + o.fullN + ' null样本=' + o.nullN + ' 盲区样本=' + o.blind);
    }
    const byS = {};
    for (const r of oldS) { const o = byS[r.id] = byS[r.id] || { n: 0, dmax: 0, nullN: 0, t0: r.t, t1: r.t };
      o.n++; if (r.d > o.dmax) o.dmax = r.d; if (r.pxNull) o.nullN++; if (r.t < o.t0) o.t0 = r.t; if (r.t > o.t1) o.t1 = r.t; }
    console.log('空弹窗口陈旧行逐弹（行数 / Δmax / null / 首末 t）：');
    for (const id of Object.keys(byS).sort((a, b) => byS[b].n - byS[a].n).slice(0, 8)) {
      const o = byS[id];
      console.log('   ' + String(id).padEnd(14) + ' 行=' + String(o.n).padStart(4) + ' Δmax=' + r3(o.dmax).toFixed(3) + ' null=' + o.nullN + ' t=' + r3(o.t0) + '~' + r3(o.t1));
    }
    if (firstLiveEx) console.log('liveAnchors 原样示例（第一帧有活弹）= ' + JSON.stringify(firstLiveEx).slice(0, 400));
    console.log('wallMs=' + (Date.now() - t0));
  } catch (e) { console.error('FAILED:', (e && e.stack) || e); process.exitCode = 1; }
  finally { await m.close(); }
})();
