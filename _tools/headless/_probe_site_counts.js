'use strict';
/* 探针：逐调用点比较 record 与 replay 的消费条数 —— 找出哪个调用点在两边的
 * 调用次数不同（这是 per-site 分流之后仍会漂的根因候选）。
 *   node _tools/headless/_probe_site_counts.js --frames 1200
 */
const fs = require('fs');
const path = require('path');
const { Match } = require('./match');
const { recordEpisode, readRecording, replayEpisode } = require('./record');

let replayCounts = null, replayStacks = null;
const origClose = Match.prototype.close;
Match.prototype.close = async function () {
  try {
    if (this.__wantSiteCounts) {
      replayCounts = await this.eval('window.__vtRng.useCounts()');
      replayStacks = await this.eval('window.__vtRng.stacks()');
    }
  } catch (e) {}
  return origClose.call(this);
};

const argv = process.argv.slice(2);
const num = (n, d) => { const i = argv.indexOf('--' + n); return i < 0 ? d : Number(argv[i + 1]); };
const FRAMES = num('frames', 1200);

(async () => {
  const recFile = path.join(__dirname, 'prof', 'detfix', `sitecounts_rec_${FRAMES}.jsonl`);
  const repFile = path.join(__dirname, 'prof', 'detfix', `sitecounts_rep_${FRAMES}.jsonl`);
  const origOpen = Match.prototype.open;
  Match.prototype.open = async function (opts) {
    const r = await origOpen.call(this, opts);
    if (opts && opts.rng === 'record') await this.eval('window.__vtRng.debugStacks(true)');
    return r;
  };
  const m2 = new Match();
  await recordEpisode(m2, { frames: FRAMES, out: recFile });
  const recCounts = await m2.eval('window.__vtRng.useCounts()');
  const recStacks = await m2.eval('window.__vtRng.stacks()');
  await m2.close();
  Match.prototype.open = origOpen;

  const rec = readRecording(recFile);
  replayCounts = null;
  // replayEpisode 内部 new Match：用原型标记让 close 抓取 useCounts
  const saved = Match.prototype.__wantSiteCounts;
  Match.prototype.__wantSiteCounts = true;
  await replayEpisode(rec, { out: repFile });
  Match.prototype.__wantSiteCounts = saved;

  const keys = new Set(Object.keys(recCounts).concat(Object.keys(replayCounts || {})));
  const diffs = [];
  for (const k of keys) {
    const a = recCounts[k] || 0, b = (replayCounts || {})[k] || 0;
    if (a !== b) diffs.push({ key: k, rec: a, rep: b, stack: recStacks ? recStacks[k] : null });
  }
  const out = { frames: FRAMES, recSites: Object.keys(recCounts).length, repSites: Object.keys(replayCounts || {}).length,
                diffSites: diffs.length, diffs: diffs.slice(0, 40) };
  const outFile = path.join(__dirname, 'prof', 'detfix', `sitecounts_report_${FRAMES}.json`);
  fs.writeFileSync(outFile, JSON.stringify(out, null, 2));
  console.log(JSON.stringify({ ok: true, out: outFile, diffSites: diffs.length, sample: diffs.slice(0, 10) }, null, 2));
})().catch((e) => { console.error('FAILED:', (e && e.stack) || e); process.exitCode = 1; });
