'use strict';
/* 探针：逐次比较 record / replay 的 Math.random 返回【值】与调用点 key。
 * 若两者逐位相同而游戏仍漂 ⟹ 漂移与随机数无关。
 *   node _tools/headless/_probe_rng_trace.js --frames 600
 */
const fs = require('fs');
const path = require('path');
const { Match } = require('./match');
const { recordEpisode, readRecording, replayEpisode } = require('./record');

let repTrace = null;
const origClose = Match.prototype.close;
Match.prototype.close = async function () {
  try {
    if (this.__wantTrace) {
      const n = await this.eval('window.__vtRng.traceLen()');
      const out = [];
      for (let i = 0; i < n; i += 5000) out.push(...await this.eval(`window.__vtRng.dumpTrace(${i}, 5000)`));
      repTrace = out;
    }
  } catch (e) { this.__traceErr = String(e && e.message || e); }
  return origClose.call(this);
};
async function dumpTrace(m) {
  const n = await m.eval('window.__vtRng.traceLen()');
  const out = [];
  for (let i = 0; i < n; i += 5000) out.push(...await m.eval(`window.__vtRng.dumpTrace(${i}, 5000)`));
  return out;
}
const argv = process.argv.slice(2);
const num = (n, d) => { const i = argv.indexOf('--' + n); return i < 0 ? d : Number(argv[i + 1]); };
const FRAMES = num('frames', 600);
(async () => {
  const recFile = path.join(__dirname, 'prof', 'detfix', `trace_rec_${FRAMES}.jsonl`);
  const repFile = path.join(__dirname, 'prof', 'detfix', `trace_rep_${FRAMES}.jsonl`);
  const origOpen = Match.prototype.open;
  Match.prototype.open = async function (opts) {
    const r = await origOpen.call(this, opts);
    await this.eval('window.__vtRng.trace(true)');
    return r;
  };
  const m = new Match();
  await recordEpisode(m, { frames: FRAMES, out: recFile });
  const recTrace = await dumpTrace(m);
  await m.close();

  const rec = readRecording(recFile);
  Match.prototype.__wantTrace = true;
  await replayEpisode(rec, { out: repFile });
  Match.prototype.__wantTrace = false;
  Match.prototype.open = origOpen;

  const n = Math.min(recTrace.length, (repTrace || []).length);
  let first = -1;
  for (let i = 0; i < n; i++) {
    const a = recTrace[i], b = repTrace[i];
    if (a[1] !== b[1] || a[2] !== b[2] || a[3] !== b[3]) { first = i; break; }
  }
  const out = { frames: FRAMES, recCalls: recTrace.length, repCalls: (repTrace || []).length, firstValueOrKeyDiff: first };
  if (first >= 0) {
    out.rec = recTrace.slice(Math.max(0, first - 3), first + 5);
    out.rep = (repTrace || []).slice(Math.max(0, first - 3), first + 5);
  }
  const f = path.join(__dirname, 'prof', 'detfix', `trace_report_${FRAMES}.json`);
  fs.writeFileSync(f, JSON.stringify(out, null, 2));
  console.log(JSON.stringify({ ok: true, out: f, recCalls: out.recCalls, repCalls: out.repCalls, firstValueOrKeyDiff: first }, null, 2));
})().catch((e) => { console.error('FAILED:', (e && e.stack) || e); process.exitCode = 1; });
