'use strict';
/* 探针：Box2D world 内部状态逐帧对拍 —— 找"哪个字段先不一样"（不是哪一帧开始不对）
 *
 * 采集（record 与 replay 两边都采）：
 *   · body 列表【顺序】 + 每个 body 的首次见到序号(creation/list order)、type、m_flags、
 *     m_sleepTime、fixture 几何/过滤位（categoryBits/maskBits/groupIndex/type/radius/顶点）
 *   · contact 列表【顺序】 + 两端 body 序号、m_flags、pointCount
 *   · world.m_allowSleep / m_contactCount / m_stepCount（若此 Box2D 移植版有）
 *
 *   node _tools/headless/_probe_world_order.js --frames 400
 */
const fs = require('fs');
const path = require('path');

const cdp = require('./cdp');
const realLaunch = cdp.launch;
let launchSeq = 0;
const LAUNCH_BASE = 17400 + (process.pid % 30) * 40;

const POST = `(() => {
  if (window.__vtWorldSig) return;
  var P = { on: true, frames: [], cap: 900, seq: 0, err: null, bodyIds: null, fixIds: null };
  window.__vtWorldSig = P;
  try { P.bodyIds = new WeakMap(); } catch (e) { P.bodyIds = null; }
  function poly(vs) {
    if (!vs) return null;
    var out = [], n = Math.min(vs.length, 12);
    for (var i = 0; i < n; i++) out.push([Math.round(vs[i].x * 10000), Math.round(vs[i].y * 10000)]);
    return out;
  }
  function bid(b) {
    var id = P.bodyIds.get(b);
    if (id === undefined) { id = ++P.seq; P.bodyIds.set(b, id); }
    return id;
  }
  /** 语义 id：坦克/子弹/陷阱/区域/道具 → 稳定名字；墙 → 首个 fixture 顶点的绝对坐标 */
  function buildSMap(gc) {
    var sm = new WeakMap(), m = null;
    try { m = gc.roundController && gc.roundController.model; } catch (e) {}
    if (m) {
      var groups = [['tanks','T:'], ['projectiles','P:'], ['traps','R:'], ['zones','Z:'], ['collectibles','C:']];
      for (var g = 0; g < groups.length; g++) {
        var obj = m[groups[g][0]] || {};
        for (var k in obj) {
          try {
            var ent = obj[k];
            if (ent && typeof ent.getB2DBody === 'function') {
              var bb = ent.getB2DBody();
              if (bb) sm.set(bb, groups[g][1] + k);
            }
          } catch (e2) {}
        }
      }
    }
    return sm;
  }
  function sid(sm, b, f0) {
    var v = null; try { v = sm.get(b); } catch (e) {}
    if (v) return v;
    try {
      if (f0 && f0.m_shape && f0.m_shape.m_vertices && f0.m_shape.m_vertices.length) {
        var p0 = f0.m_shape.m_vertices[0];
        return 'W' + Math.round(p0.x * 100) + ',' + Math.round(p0.y * 100);
      }
      if (f0 && f0.m_shape && f0.m_shape.m_radius) {
        var pos0 = b.m_xf ? b.m_xf.position : null;
        if (pos0) return 'S' + Math.round(pos0.x * 100) + ',' + Math.round(pos0.y * 100);
      }
    } catch (e) {}
    return '?';
  }
  function round4(x) { return Math.round((x || 0) * 10000) / 10000; }
  window.__vtAfter.push(function () {
    if (!P.on || P.frames.length >= P.cap) return;
    try {
      var gc = window.GameManager && GameManager.getGameController ? GameManager.getGameController() : null;
      if (!gc) return;
      var w = null; try { w = gc.getB2DWorld(); } catch (e) {}
      if (!w || !w.GetBodyList) return;
      var sm = buildSMap(gc);
      var bodies = [], b = w.GetBodyList(), n = 0;
      while (b && n < 500) {
        var fx = [], f = b.m_fixtureList, fi = 0;
        while (f && fi < 8) {
          var sh = f.m_shape || {};
          fx.push([
            f.m_filter ? f.m_filter.categoryBits : -1,
            f.m_filter ? f.m_filter.maskBits : -1,
            f.m_filter ? f.m_filter.groupIndex : -1,
            sh.m_type, Math.round((sh.m_radius || 0) * 10000), sh.m_vertexCount || 0, poly(sh.m_vertices)
          ]);
          f = f.m_next; fi++;
        }
        var xf = b.m_xf || {}, lv = b.m_linearVelocity || {};
        bodies.push([sid(sm, b, b.m_fixtureList), bid(b), b.m_type, b.m_flags,
                     +((b.m_sleepTime || 0)).toFixed(5),
                     b.m_awake === undefined ? null : !!b.m_awake,
                     round4(xf.position ? xf.position.x : 0), round4(xf.position ? xf.position.y : 0),
                     round4(xf.angle), round4(lv.x), round4(lv.y), round4(b.m_angularVelocity),
                     fx]);
        b = b.m_next; n++;
      }
      var contacts = [], c = w.m_contactList, cn = 0;
      while (c && cn < 500) {
        var fA = c.m_fixtureA, fB = c.m_fixtureB;
        var man = c.m_manifold, mpts = [];
        if (man && man.m_points) {
          for (var q = 0; q < man.m_points.length && q < 4; q++) {
            var pt = man.m_points[q];
            mpts.push([round4(pt.normalImpulse), round4(pt.tangentImpulse),
                       round4(pt.localPoint ? pt.localPoint.x : 0), round4(pt.localPoint ? pt.localPoint.y : 0)]);
          }
        }
        contacts.push([
          fA && fA.m_body ? sid(sm, fA.m_body, fA) : '?',
          fB && fB.m_body ? sid(sm, fB.m_body, fB) : '?',
          c.m_flags, man ? man.m_pointCount : -1, mpts
        ]);
        c = c.m_next; cn++;
      }
      P.frames.push({
        steps: window.__vt.steps, t: Math.round(window.__vt.t * 1000) / 1000,
        allowSleep: !!w.m_allowSleep,
        hasStepCount: (w.m_stepCount === undefined) ? null : w.m_stepCount,
        bodyCount: w.m_bodyCount | 0, contactCount: w.m_contactCount | 0,
        bodies: bodies, contacts: contacts
      });
    } catch (e) { if (!P.err) P.err = String((e && e.stack) || e); }
  });
})();`;

cdp.launch = function (opts) {
  const o = Object.assign({}, opts || {});
  if (!o.port) o.port = LAUNCH_BASE + (launchSeq++) % 40;
  return realLaunch(o).then((b) => {
    const origSend = b.send.bind(b);
    b.send = function (method, params, sessionId) {
      if (method === 'Page.addScriptToEvaluateOnNewDocument' && params && params.source) {
        params = Object.assign({}, params, { source: params.source + ';' + POST });
      }
      return origSend(method, params, sessionId);
    };
    return b;
  });
};

const { Match } = require('./match');
const { recordEpisode, readRecording, replayEpisode } = require('./record');

async function dumpSig(m) {
  const n = await m.eval('window.__vtWorldSig ? window.__vtWorldSig.frames.length : 0');
  const out = [];
  for (let i = 0; i < n; i += 40) out.push(...await m.eval(`window.__vtWorldSig.frames.slice(${i}, ${i + 40})`));
  const err = await m.eval('window.__vtWorldSig ? window.__vtWorldSig.err : null');
  return { frames: out, err };
}

let repSig = null;
const origClose = Match.prototype.close;
Match.prototype.close = async function () {
  try { if (this.__wantSig) repSig = await dumpSig(this); } catch (e) { if (!this.__sigErr) this.__sigErr = String(e && e.message); }
  return origClose.call(this);
};

const argv = process.argv.slice(2);
const num = (n, d) => { const i = argv.indexOf('--' + n); return i < 0 ? d : Number(argv[i + 1]); };
const FRAMES = num('frames', 400);
const OUTDIR = path.join(__dirname, 'prof', 'detfix');

(async () => {
  const recFile = path.join(OUTDIR, `world_rec_${FRAMES}.jsonl`);
  const repFile = path.join(OUTDIR, `world_rep_${FRAMES}.jsonl`);
  const m = new Match();
  await recordEpisode(m, { frames: FRAMES, out: recFile });
  const recSig = await dumpSig(m);
  await m.close();

  const rec = readRecording(recFile);
  Match.prototype.__wantSig = true;
  await replayEpisode(rec, { out: repFile });
  Match.prototype.__wantSig = false;

  // 只比较两边都采到的帧，以 steps 为对齐键
  const repBySteps = new Map();
  for (const f of (repSig ? repSig.frames : [])) repBySteps.set(f.steps, f);
  const report = { frames: FRAMES, recSigFrames: recSig.frames.length, repSigFrames: repSig ? repSig.frames.length : 0,
                   recErr: recSig.err, repErr: repSig ? repSig.err : null, firstDiff: null, perFieldFirstDiff: {} };
  const fields = ['allowSleep', 'hasStepCount', 'bodyCount', 'contactCount', 'bodies', 'contacts'];
  for (const f of recSig.frames) {
    const g = repBySteps.get(f.steps);
    if (!g) continue;
    for (const k of fields) {
      if (JSON.stringify(f[k]) === JSON.stringify(g[k])) continue;
      if (report.perFieldFirstDiff[k] === undefined) {
        report.perFieldFirstDiff[k] = { steps: f.steps, rec: f[k], rep: g[k] };
      }
      if (report.firstDiff === null) {
        report.firstDiff = { steps: f.steps, field: k, rec: f[k], rep: g[k] };
      }
    }
    if (report.firstDiff) break;
  }
  // 如果 firstDiff 是 bodies/contacts，给出更细的"第一个不同的 body/contact 元素"
  if (report.firstDiff && (report.firstDiff.field === 'bodies' || report.firstDiff.field === 'contacts')) {
    const a = report.firstDiff.rec, b = report.firstDiff.rep;
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) {
      if (JSON.stringify(a[i]) !== JSON.stringify(b[i])) { report.firstDiff.elementIndex = i; report.firstDiff.recElem = a[i]; report.firstDiff.repElem = b[i]; break; }
    }
    if (report.firstDiff.elementIndex === undefined && a.length !== b.length) {
      report.firstDiff.elementIndex = n; report.firstDiff.recElem = a[n]; report.firstDiff.repElem = b[n];
    }
  }
  // 分歧帧前后各取 2 帧上下文（含 bodies/contacts 全量），用于判断"事件晚了"还是"根本没触发"
  if (report.firstDiff) {
    const idxRec = recSig.frames.findIndex((f) => f.steps === report.firstDiff.steps);
    const s0 = report.firstDiff.steps - 2, s1 = report.firstDiff.steps + 1;
    report.context = {
      rec: recSig.frames.slice(Math.max(0, idxRec - 2), idxRec + 2),
      rep: (repSig ? repSig.frames : []).filter((f) => f.steps >= s0 && f.steps <= s1),
    };
  }
  const outFile = path.join(OUTDIR, `world_report_${FRAMES}.json`);
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ok: true, out: outFile, recSigFrames: report.recSigFrames, repSigFrames: report.repSigFrames,
    firstDiff: report.firstDiff ? { steps: report.firstDiff.steps, field: report.firstDiff.field, elementIndex: report.firstDiff.elementIndex } : null,
    perFieldFirstDiff: Object.keys(report.perFieldFirstDiff).reduce((o, k) => (o[k] = report.perFieldFirstDiff[k].steps, o), {}),
    allowSleep: recSig.frames.length ? recSig.frames[0].allowSleep : null, errs: [report.recErr, report.repErr] }, null, 2));
})().catch((e) => { console.error('FAILED:', (e && e.stack) || e); process.exitCode = 1; });
