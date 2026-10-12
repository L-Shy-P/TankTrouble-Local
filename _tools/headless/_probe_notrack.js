'use strict';
/* 探针：生产对局里【没有 track】的威胁占多少
 * ==========================================
 * 只读产品代码（game_core/ 一字节不改），只在页面内存里包一层
 * VantageScoring.computeThreats（拿 fallbackPath 标记），并每帧读
 * VantageTree.dumpDiagnostics() 的 threats / threatAnchors（trackLen）。
 *
 *   node _tools/headless/_probe_notrack.js --frames 9000 --ai 2 --tag natural
 *
 * 「没有 track」判据（与消费端一致）：
 *   th.track && th.track.length > 0  → 有 track（trackPosAt / threatPosAtTree /
 *   threatBulletPos / Rust threat_bullet_pos 全部优先走它）
 *   否则 → 只有折线 path（生产里的「折线回退」口径）
 *   dumpDiagnostics().threatAnchors[].trackLen 就是 snapshotThreatAnchors 时
 *   对同一个 th 对象算出的 track.length ⇒ 可信。
 */
const fs = require('fs');
const path = require('path');
const { Match } = require('./match');

function arg(n, d) { const i = process.argv.indexOf('--' + n); return i < 0 ? d : Number(process.argv[i + 1]); }
function sarg(n, d) { const i = process.argv.indexOf('--' + n); return i < 0 ? d : process.argv[i + 1]; }

const PAGE_SETUP = `(() => {
  if (window.__nt && window.__nt.on) return 'already';
  var NT = window.__nt = {
    on: true, err: null,
    frames: 0, noTree: 0,
    sumThreat: 0, sumNoTrack: 0,
    framesWithThreat: 0, framesWithNoTrack: 0, framesAllNoTrack: 0, framesZeroThreat: 0,
    framesGoneThreat: 0,
    kindHist: {}, typeHistAll: {}, typeHistNoTrack: {}, typeHistGone: {},
    projTypeHist: {}, diagTrackCount: {}, trackSourceHist: {},
    histNoTrackPerFrame: {}, streak: { cur: 0, max: 0 },
    idMismatch: 0, mismatchKinds: {},
    samples: [], events: [], evCap: 400,
    tMin: null, tMax: null,
    projTypesSeen: {}, threatTypesSeen: {}, collectibleTypesSeen: {}, weaponTypesSeen: {},
    weaponOfTank: {},
    rawById: {}, rawTrackAgree: 0, rawTrackDisagree: 0, rawTrackUnknown: 0,
    frozenFrames: 0, liveFrames: 0,
    liveThreatFrames: 0, liveNoTrackThreatFrames: 0, liveFramesWithNoTrack: 0,
    liveFramesAllNoTrack: 0, liveKindHist: {}, liveTypeHistNoTrack: {}, liveTypeHistAll: {},
    liveEvents: [], byId: {}, goneEvents: [], goneFrameList: [], lastTypeById: {},
    tFrozenFrames: 0, lastT: null, goneFrozenT: 0, goneAdvancedT: 0, tTrace: [], traceIds: {}
  };

  // id -> 该弹的折线是不是 computeThreats 的兜底短直线
  window.__ntFallback = {};
  try {
    if (window.VantageScoring && VantageScoring.computeThreats && !VantageScoring.__ntWrapped) {
      var _orig = VantageScoring.computeThreats;
      VantageScoring.computeThreats = function () {
        var out = _orig.apply(this, arguments);
        try {
          if (out && out.length) {
            for (var i = 0; i < out.length; i++) {
              var pp = out[i];
              if (pp && pp.id !== undefined) {
                window.__ntFallback[pp.id] = !!pp.fallbackPath;
                NT.rawById[pp.id] = pp;
              }
            }
          }
        } catch (e) {}
        return out;
      };
      VantageScoring.__ntWrapped = true;
    }
  } catch (eW) { NT.err = 'wrap: ' + String(eW && eW.message || eW); }

  window.__ntSample = function () {
    var VT = window.VantageTree;
    if (!VT || !VT.dumpDiagnostics) { NT.noTree++; return; }
    var d = null;
    try { d = VT.dumpDiagnostics(); } catch (e) { NT.err = 'diag: ' + String(e && e.message || e); return; }
    if (!d) { NT.noTree++; return; }

    var ths = d.threats || [];
    var anchors = d.threatAnchors || [];

    // 真实在场弹：id -> type
    var live = {}, projKinds = {}, projN = 0;
    var roundId = null;
    try {
      var gc = window.GameManager.getGameController();
      roundId = gc && gc.getRoundId ? gc.getRoundId() : null;
      var prs = (gc && gc.getProjectiles) ? gc.getProjectiles() : null;
      for (var id in prs) {
        if (!prs.hasOwnProperty(id)) continue;
        var p = prs[id];
        var tp = null;
        try { tp = (p && p.getType) ? p.getType() : null; } catch (e) {}
        live[id] = tp; projKinds['t' + tp] = (projKinds['t' + tp] || 0) + 1; projN++;
        NT.projTypesSeen['t' + tp] = (NT.projTypesSeen['t' + tp] || 0) + 1;
        NT.lastTypeById[id] = tp;
      }
      // 场上道具（箱）类型：确认武器箱到底有没有刷
      var cols = (gc && gc.getCollectibles) ? gc.getCollectibles() : null;
      for (var cid in cols) {
        if (!cols.hasOwnProperty(cid)) continue;
        var cb = cols[cid];
        var ct = null;
        try { ct = (cb && cb.getType) ? cb.getType() : null; } catch (e) {}
        NT.collectibleTypesSeen['c' + ct] = (NT.collectibleTypesSeen['c' + ct] || 0) + 1;
      }
      // 每辆坦克手上的武器类型（用 getActiveWeapon(pid)）
      var pids = (gc && gc.getActivePlayerIds) ? gc.getActivePlayerIds() : [];
      pids = window.__vtArr ? window.__vtArr(pids) : pids;
      for (var wp2 = 0; wp2 < (pids ? pids.length : 0); wp2++) {
        var pid = pids[wp2];
        var aw = null;
        try { aw = gc.getActiveWeapon ? gc.getActiveWeapon(pid) : null; } catch (e) {}
        if (!aw) continue;
        var wt2 = null;
        try { wt2 = aw.getType(); } catch (e) {}
        NT.weaponOfTank[pid] = wt2;
        NT.weaponTypesSeen['w' + wt2] = (NT.weaponTypesSeen['w' + wt2] || 0) + 1;
      }
    } catch (e) {}

    NT.frames++;
    var tNow = +(+d.tNow || 0);
    var tFrozen = (NT.lastT !== null && Math.abs(tNow - NT.lastT) < 1e-9);
    NT.lastT = tNow;
    if (tFrozen) NT.tFrozenFrames++;
    if (NT.tTrace.length < 20000) NT.tTrace.push([NT.frames, +tNow.toFixed(4), tFrozen ? 1 : 0]);
    if (NT.tMin === null || tNow < NT.tMin) NT.tMin = tNow;
    if (NT.tMax === null || tNow > NT.tMax) NT.tMax = tNow;
    if (d.diag) {
      var tc = (d.diag.trackCount === undefined) ? 'undef' : String(d.diag.trackCount);
      NT.diagTrackCount[tc] = (NT.diagTrackCount[tc] || 0) + 1;
    }
    for (var pk in projKinds) NT.projTypeHist[pk] = NT.projTypeHist[pk] || {};
    for (var pk2 in projKinds) NT.projTypeHist[pk2][projKinds[pk2]] = (NT.projTypeHist[pk2][projKinds[pk2]] || 0) + 1;

    var aById = {};
    for (var i = 0; i < anchors.length; i++) {
      var a = anchors[i];
      if (a && a.id !== undefined) aById[a.id] = a;
    }

    var frozen = false;
    try { frozen = !!(VT.isFrozen && VT.isFrozen()); } catch (e) {}
    if (frozen) NT.frozenFrames++; else NT.liveFrames++;
    NT.frameFrozen = frozen;

    var nTh = 0, nNT = 0, nGone = 0, kinds = {};
    var liveNTh = 0, liveNNT = 0, liveGone = 0, liveKinds = {}, liveTypes = {};
    for (var j = 0; j < ths.length; j++) {
      var th = ths[j];
      if (!th) continue;
      nTh++;
      var liveT = (th.id in live) ? live[th.id] : null;
      NT.typeHistAll['t' + liveT] = (NT.typeHistAll['t' + liveT] || 0) + 1;
      NT.threatTypesSeen['t' + liveT] = (NT.threatTypesSeen['t' + liveT] || 0) + 1;
      if (!(th.id in live)) {
        nGone++; NT.typeHistGone['t' + liveT] = (NT.typeHistGone['t' + liveT] || 0) + 1;
        if (!frozen) {
          NT.goneFrameList.push(NT.frames);
          if (tFrozen) NT.goneFrozenT++; else NT.goneAdvancedT++;
          if (NT.goneEvents.length < 400) {
            NT.goneEvents.push({ f: NT.frames, t: tNow, tFrozen: tFrozen, id: String(th.id),
                                 lastType: (th.id in NT.lastTypeById) ? NT.lastTypeById[th.id] : null,
                                 nTh: nTh, nNT: nNT, roundId: roundId === null ? null : String(roundId) });
          }
        }
      }

      var a2 = aById[th.id];
      var hasAnchor = (a2 !== undefined);
      var tl = hasAnchor ? (a2.trackLen || 0) : null;
      var src = hasAnchor ? (a2.trackSource || '?') : 'noAnchor';
      NT.trackSourceHist[src] = (NT.trackSourceHist[src] || 0) + 1;
      if (!hasAnchor) {
        NT.idMismatch++;
        var mk = 'noAnchor|t' + liveT;
        NT.mismatchKinds[mk] = (NT.mismatchKinds[mk] || 0) + 1;
      }
      // 交叉校验：computeThreats 返回的原始对象（多数路径与树是同一个引用）
      var raw = NT.rawById[th.id];
      if (raw) {
        var rawHas = !!(raw.track && raw.track.length);
        if (hasAnchor) {
          if (rawHas === (tl > 0)) NT.rawTrackAgree++;
          else if (tl > 0 || rawHas) NT.rawTrackDisagree++;
        }
      } else NT.rawTrackUnknown++;

      if (!frozen) {
        liveNTh++;
        if (!(th.id in live)) liveGone++;
        liveTypes['t' + liveT] = (liveTypes['t' + liveT] || 0) + 1;
      }
      if (hasAnchor && tl > 0) continue;      // 有可用 track
      nNT++;
      if (!frozen) liveNNT++;
      var fb = window.__ntFallback[th.id];
      var fbKey = (fb === true) ? 'fallbackPath' : (fb === false ? 'normalPath' : 'unknownPath');
      var key = 'type' + liveT + '|' + fbKey + '|' + ((th.id in live) ? 'live' : 'gone') +
                '|' + (hasAnchor ? ('trackLen' + tl + ':src' + src) : 'noAnchor');
      kinds[key] = (kinds[key] || 0) + 1;
      NT.kindHist[key] = (NT.kindHist[key] || 0) + 1;
      var bid = String(th.id);
      if (!NT.byId[bid]) NT.byId[bid] = { n: 0, type: liveT, gone: 0, frozen: 0, f0: NT.frames, kinds: {} };
      NT.byId[bid].n++;
      NT.byId[bid].type = liveT;
      if (!(th.id in live)) NT.byId[bid].gone++;
      if (frozen) NT.byId[bid].frozen++;
      NT.byId[bid].kinds[key] = (NT.byId[bid].kinds[key] || 0) + 1;
      NT.typeHistNoTrack['t' + liveT] = (NT.typeHistNoTrack['t' + liveT] || 0) + 1;
    }

    NT.sumThreat += nTh; NT.sumNoTrack += nNT;
    if (!frozen) {
      NT.liveThreatFrames += nTh; NT.liveNoTrackThreatFrames += nNT;
      if (nNT > 0) NT.liveFramesWithNoTrack++;
      if (nTh > 0 && nNT === nTh) NT.liveFramesAllNoTrack++;
      for (var lk in kinds) NT.liveKindHist[lk] = (NT.liveKindHist[lk] || 0) + kinds[lk];
      for (var lt in liveTypes) NT.liveTypeHistAll[lt] = (NT.liveTypeHistAll[lt] || 0) + liveTypes[lt];
      for (var lk2 in kinds) {
        var m2 = /^type([^|]*)\|/.exec(lk2);
        if (m2) NT.liveTypeHistNoTrack['t' + m2[1]] = (NT.liveTypeHistNoTrack['t' + m2[1]] || 0) + kinds[lk2];
      }
      if (nNT > 0 && NT.liveEvents.length < 400) {
        NT.liveEvents.push({ f: NT.frames, t: +tNow.toFixed(3), nTh: nTh, nNT: nNT, nGone: liveGone,
                             ids: ths.map(function (z) { return String(z && z.id); }),
                             kinds: kinds, projKinds: projKinds, frozen: false,
                             roundId: roundId === null ? null : String(roundId) });
      }
    }
    if (nTh > 0) NT.framesWithThreat++;
    if (nTh === 0) NT.framesZeroThreat++;
    if (nGone > 0) NT.framesGoneThreat++;
    if (nNT > 0) {
      NT.framesWithNoTrack++;
      NT.streak.cur++;
      if (NT.streak.cur > NT.streak.max) NT.streak.max = NT.streak.cur;
    } else NT.streak.cur = 0;
    if (nTh > 0 && nNT === nTh) NT.framesAllNoTrack++;
    var hk = nNT === 0 ? '0' : (nNT === 1 ? '1' : (nNT <= 4 ? '2-4' : '5+'));
    NT.histNoTrackPerFrame[hk] = (NT.histNoTrackPerFrame[hk] || 0) + 1;
    if (NT.samples.length < 40000) NT.samples.push([NT.frames, nTh, nNT, roundId === null ? '?' : String(roundId), projN]);

    if (nNT > 0 && NT.events.length < NT.evCap) {
      NT.events.push({
        f: NT.frames, t: tNow, nTh: nTh, nNT: nNT, nGone: nGone, projN: projN, frozen: frozen,
        kinds: kinds, projKinds: projKinds, roundId: roundId === null ? null : String(roundId),
        trackCount: (d.diag && d.diag.trackCount !== undefined) ? d.diag.trackCount : null,
        diagProjCount: (d.diag && d.diag.projectileCount) || 0
      });
    }
  };
  // 探针注入：在可达格心刷一个武器箱（走真实 spawnCrate API）
  window.__ntArm = function (typeIdx) {
    var out = { type: typeIdx };
    try {
      var gc = window.GameManager.getGameController();
      if (!gc || !gc.roundController) { out.err = 'no roundController'; return out; }
      var mz = gc.getMaze();
      if (!mz) { out.err = 'no maze'; return out; }
      var TILE = Constants.MAZE_TILE_SIZE.m;
      var cells = mz.reachable;
      out.reachableLen = (cells && cells.length !== undefined) ? cells.length : -1;
      if (!cells || !cells.length) { out.err = 'no reachable'; return out; }
      var c = cells[(Math.random() * cells.length) | 0];
      out.cellSample = JSON.parse(JSON.stringify(c));
      var x, y;
      if (c && c.x !== undefined) { x = c.x; y = c.y; }
      else if (c && c.length >= 2) { x = c[0]; y = c[1]; }
      else { out.err = 'unknown cell format'; return out; }
      if (x < mz.width && y < mz.height) { x = (x + 0.5) * TILE; y = (y + 0.5) * TILE; out.unit = 'tile'; }
      else out.unit = 'world';
      out.pos = { x: x, y: y };
      gc.roundController.spawnCrate(typeIdx, { x: x, y: y, rotation: 0 });
      out.ok = true;
    } catch (e) { out.err = String((e && e.message) || e); }
    return out;
  };

  // 探针注入：把武器箱刷到 tank_a 自己脚下（真实 spawnCrate + 真实碰撞拾取）
  window.__ntGiveSelf = function (typeIdx) {
    var out = { type: typeIdx };
    try {
      var gc = window.GameManager.getGameController();
      if (!gc || !gc.roundController) { out.err = 'no roundController'; return out; }
      var tank = gc.getTank('tank_a');
      if (!tank) { out.err = 'no tank_a'; return out; }
      var pos = { x: tank.getX(), y: tank.getY(), rotation: 0 };
      out.pos = pos;
      out.before = (gc.getActiveWeapon && gc.getActiveWeapon('tank_a')) ?
        gc.getActiveWeapon('tank_a').getType() : null;
      gc.roundController.spawnCrate(typeIdx, pos);
      out.ok = true;
    } catch (e) { out.err = String((e && e.message) || e); }
    return out;
  };
  window.__ntMineAt = function () {
    try {
      var gc = window.GameManager.getGameController();
      var traps = gc.getTraps ? gc.getTraps() : null;
      var out = [];
      for (var tid in traps) {
        if (!traps.hasOwnProperty(tid)) continue;
        var tr = traps[tid];
        out.push({ id: tid, type: tr.getType ? tr.getType() : null,
                   x: tr.getX ? tr.getX() : null, y: tr.getY ? tr.getY() : null,
                   alive: tr.getTimeAlive ? +tr.getTimeAlive().toFixed(2) : null });
      }
      return out;
    } catch (e) { return 'err:' + String(e && e.message || e); }
  };
  window.__ntWeaponOf = function (pid) {
    try {
      var gc = window.GameManager.getGameController();
      var aw = gc.getActiveWeapon(pid);
      return aw ? aw.getType() : null;
    } catch (e) { return 'err:' + String(e && e.message || e).slice(0, 60); }
  };

  window.__vtAfter.push(window.__ntSample);
  return 'installed';
})()`;

const PAGE_AGG = `(() => {
  var NT = window.__nt;
  if (!NT) return { err: 'no __nt' };
  NT.on = false;
  var s = NT.samples, i;
  var nTh = [], nNT = [];
  for (i = 0; i < s.length; i++) { nTh.push(s[i][1]); nNT.push(s[i][2]); }
  function sum(a) { var t = 0; for (var z = 0; z < a.length; z++) t += a[z]; return t; }
  function q(a, p) { var b = a.slice().sort(function (x, y) { return x - y; });
    return b.length ? b[Math.min(b.length - 1, Math.floor(b.length * p))] : null; }
  // 按 roundId 分组
  var byRound = {}, order = [];
  for (i = 0; i < s.length; i++) {
    var r = s[i][3];
    if (!byRound[r]) { byRound[r] = { frames: 0, threatFrames: 0, noTrackThreatFrames: 0, framesWithNoTrack: 0, maxProj: 0 }; order.push(r); }
    var g = byRound[r];
    g.frames++; g.threatFrames += s[i][1]; g.noTrackThreatFrames += s[i][2];
    if (s[i][2] > 0) g.framesWithNoTrack++;
    if (s[i][4] > g.maxProj) g.maxProj = s[i][4];
  }
  for (var k in byRound) {
    var gg = byRound[k];
    gg.占比 = gg.threatFrames ? +(gg.noTrackThreatFrames / gg.threatFrames).toFixed(5) : null;
  }
  return {
    frames: NT.frames, noTree: NT.noTree, err: NT.err,
    frozenFrames: NT.frozenFrames, liveFrames: NT.liveFrames,
    liveThreatFrames: NT.liveThreatFrames, liveNoTrackThreatFrames: NT.liveNoTrackThreatFrames,
    占比_活树威胁帧: NT.liveThreatFrames ? +(NT.liveNoTrackThreatFrames / NT.liveThreatFrames).toFixed(6) : null,
    liveFramesWithNoTrack: NT.liveFramesWithNoTrack, liveFramesAllNoTrack: NT.liveFramesAllNoTrack,
    liveKindHist: NT.liveKindHist, liveTypeHistAll: NT.liveTypeHistAll,
    liveTypeHistNoTrack: NT.liveTypeHistNoTrack, liveEvents: NT.liveEvents.slice(0, 300),
    byId: NT.byId,
    byIdTop: (function () {
      var arr = [];
      for (var k in NT.byId) { var o = NT.byId[k]; o.id = k; arr.push(o); }
      arr.sort(function (a, b) { return b.n - a.n; });
      return arr.slice(0, 15);
    })(),
    tFrozenFrames: NT.tFrozenFrames, goneFrozenT: NT.goneFrozenT, goneAdvancedT: NT.goneAdvancedT,
    goneEvents: NT.goneEvents.slice(0, 60), goneFrameCount: NT.goneFrameList.length,
    goneFrameList: NT.goneFrameList.slice(0, 400),
    sumThreat: NT.sumThreat, sumNoTrack: NT.sumNoTrack,
    占比_威胁帧: NT.sumThreat ? +(NT.sumNoTrack / NT.sumThreat).toFixed(6) : null,
    framesWithThreat: NT.framesWithThreat, framesWithNoTrack: NT.framesWithNoTrack,
    占比_有威胁的帧: NT.framesWithThreat ? +(NT.framesWithNoTrack / NT.framesWithThreat).toFixed(6) : null,
    framesAllNoTrack: NT.framesAllNoTrack, framesZeroThreat: NT.framesZeroThreat,
    framesGoneThreat: NT.framesGoneThreat,
    idMismatch: NT.idMismatch, mismatchKinds: NT.mismatchKinds,
    kindHist: NT.kindHist, typeHistAll: NT.typeHistAll, typeHistNoTrack: NT.typeHistNoTrack,
    typeHistGone: NT.typeHistGone, projTypeHist: NT.projTypeHist,
    trackSourceHist: NT.trackSourceHist, diagTrackCount: NT.diagTrackCount,
    projTypesSeen: NT.projTypesSeen, threatTypesSeen: NT.threatTypesSeen,
    collectibleTypesSeen: NT.collectibleTypesSeen, weaponTypesSeen: NT.weaponTypesSeen,
    weaponOfTank: NT.weaponOfTank,
    rawTrackAgree: NT.rawTrackAgree, rawTrackDisagree: NT.rawTrackDisagree, rawTrackUnknown: NT.rawTrackUnknown,
    histNoTrackPerFrame: NT.histNoTrackPerFrame, streakMax: NT.streak.max,
    threatPerFrame: { p50: q(nTh, .5), p95: q(nTh, .95), max: Math.max.apply(null, nTh.length ? nTh : [0]), mean: s.length ? +(sum(nTh) / s.length).toFixed(2) : null },
    noTrackPerFrame: { p50: q(nNT, .5), p95: q(nNT, .95), max: nNT.length ? Math.max.apply(null, nNT) : 0 },
    tRange: [NT.tMin, NT.tMax],
    byRound: byRound, roundOrder: order,
    eventCount: NT.events.length, events: NT.events.slice(0, 40),
    sampleTail: s.slice(-3)
  };
})()`;

(async () => {
  const frames = arg('frames', 9000);
  const ai = arg('ai', 2);
  const chunk = arg('chunk', 300);
  const tag = sarg('tag', 'natural');
  const out = sarg('out', path.join(__dirname, '_probe_notrack_' + tag + '.json'));
  const m = new Match();
  const T0 = Date.now();
  const T = () => ((Date.now() - T0) / 1000).toFixed(1) + 's';
  try {
    await m.open({ humanIds: ['tank_a'], aiCount: ai, vantCount: 1, rng: 'record' });
    console.log(`[${T()}] 开局:`, JSON.stringify(m.bootstrap), 'waitRound=', JSON.stringify(m.roundWait && m.roundWait.frames));
    const inst = await m.eval(PAGE_SETUP);
    console.log(`[${T()}] 采样器:`, inst);
    const env = await m.eval(`(() => {
      var out = { hasVT: typeof VantageTree !== 'undefined', hasScoring: typeof VantageScoring !== 'undefined' };
      try { out.modes = Object.keys(Constants.GAME_MODES).map(function(k){ return k + '=' + Constants.GAME_MODES[k]; }).join(','); } catch (e) {}
      try {
        var gm = Constants.GAME_MODE_INFO[Constants.GAME_MODES.BOOT_CAMP];
        out.bootCrates = gm && gm.DEFAULT_AVAILABLE_CRATES;
      } catch (e) { out.crateErr = String(e); }
      try { out.weaponTypes = JSON.parse(JSON.stringify(Constants.WEAPON_TYPES)); } catch (e) { out.wtErr = String(e); }
      try { out.collectibleTypes = JSON.parse(JSON.stringify(Constants.COLLECTIBLE_TYPES)); } catch (e) {}
      return out;
    })()`);
    console.log('环境:', JSON.stringify(env));

    var armLog = [];
    const arms = arg('arms', 0);            // 每 arms 帧给 AI 刷一个武器箱（0=不刷）
    const selfFire = arg('selffire', 0);    // 每 selfFire 帧给 tank_a 刷一个武器箱并持续开火（0=不刷）
    const aiId = (m.bootstrap && m.bootstrap.aiIds && m.bootstrap.aiIds[0]) || null;
    let armIdx = 0, sfIdx = 0;
    const ARM_TYPES = (sarg('armtypes', '') || '').length
      ? sarg('armtypes', '').split(',').map(function (x) { return Number(x); })
      : [0, 3, 2, 4, 1, 5];   // LASER / HOMING / SHOTGUN / MINE / DOUBLE / GATLING
    let nextArm = arms > 0 ? arms : Infinity;
    let nextSelf = selfFire > 0 ? selfFire : Infinity;
    for (let done = 0; done < frames; done += chunk) {
      await m.pump(Math.min(chunk, frames - done), { yieldMs: 0 });
      if (arms > 0 && done >= nextArm) {
        const t = ARM_TYPES[armIdx % ARM_TYPES.length]; armIdx++;
        const r = await m.eval('window.__ntArm(' + t + ')');
        let tp = null;
        if (r && r.ok && aiId) {
          try { await m.teleport(aiId, r.pos.x, r.pos.y, 0); tp = 'teleported'; }
          catch (e) { tp = 'teleport-fail:' + String((e && e.message) || e).slice(0, 90); }
        }
        r.teleport = tp; r.frame = done;
        armLog.push(r);
        console.log(`[${T()}] 给AI刷 f=${done} type=${t} ok=${!!r.ok} tel=${tp} err=${r.err || '-'} 手上武器=${await m.eval("window.__ntWeaponOf('" + aiId + "')")}`);
        nextArm += arms;
      }
      if (selfFire > 0 && done >= nextSelf) {
        const t = ARM_TYPES[sfIdx % ARM_TYPES.length]; sfIdx++;
        let r = null;
        try { r = await m.eval('window.__ntGiveSelf(' + t + ')'); } catch (e) { r = { err: String((e && e.message) || e) }; }
        r.frame = done; r.slot = 'tank_a';
        armLog.push(r);
        console.log(`[${T()}] 给tank_a刷 f=${done} type=${t} ok=${!!r.ok} err=${r.err || '-'}`);
        nextSelf += selfFire;
      }
      if (selfFire > 0 && (done % (chunk * 2)) === 0) {
        try {
          const traps = await m.eval('window.__ntMineAt()');
          if (Array.isArray(traps) && traps.length) {
            const tr = traps[0];
            if (tr && tr.x !== null && tr.y !== null) {
              try { await m.teleport('tank_a', tr.x, tr.y, 0); console.log(`[${T()}] 踩雷 f=${done} trap=${tr.id} type=${tr.type} alive=${tr.alive}`); }
              catch (e) { console.log(`[${T()}] 踩雷传送失败: ` + String((e && e.message) || e).slice(0, 70)); }
            }
          }
        } catch (e) {}
      }
      if (selfFire > 0) {
        const phase = Math.floor(done / (selfFire || 1)) % 2;
        try { await m.setControl({ left: phase === 0, right: phase === 1, fire: true }); }
        catch (e) { console.log(`[${T()}] setControl 失败: ` + String((e && e.message) || e).slice(0, 90)); }
      }
      if ((done / chunk) % 5 === 0) process.stdout.write(`[${T()}] ${done}/${frames} 帧`);
    }
    const stat = await m.eval(PAGE_AGG);
    stat.env = env;
    stat.armLog = armLog;
    stat.framesRequested = frames;
    stat.aiCount = ai;
    stat.bootstrap = m.bootstrap;
    stat.pageErrors = m.pageErrors.slice(0, 3);
    fs.writeFileSync(out, JSON.stringify(stat, null, 1));
    console.log(`\n[${T()}] 统计 -> ${out}`);
    const brief = Object.assign({}, stat);
    delete brief.events; delete brief.byRound; delete brief.sampleTail; delete brief.projTypeHist;
    console.log(JSON.stringify(brief, null, 1));
    console.log('按局:', JSON.stringify(stat.byRound));
    console.log('无 track 事件前 5 条:', JSON.stringify(stat.events.slice(0, 5), null, 1));
  } catch (e) {
    console.error('FAILED:', (e && e.stack) || e);
    process.exitCode = 1;
  } finally { await m.close(); }
})();
