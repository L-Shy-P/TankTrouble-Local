#!/usr/bin/env node
// 阶段 1-2ab 收尾 ③ 辅助证据：20 次独立新录（每次 1200 帧）分别覆盖几个回合。
// 复用 _tools/headless 的 match/record（只读 require，不改既有文件）；录完即读即删。
'use strict';
const fs = require('fs');
const path = require('path');
const cdp = require(path.resolve(__dirname, '..', '..', '_tools', 'headless', 'cdp'));
const realLaunch = cdp.launch;
let seq = 0;
const BASE = 19100 + (process.pid % 20) * 40;
cdp.launch = function (opts) {
  const o = Object.assign({}, opts || {});
  if (!o.port) o.port = BASE + (seq++) % 40;
  return realLaunch(o);
};
const { Match } = require(path.resolve(__dirname, '..', '..', '_tools', 'headless', 'match'));
const { readRecording, recordEpisode } = require(path.resolve(__dirname, '..', '..', '_tools', 'headless', 'record'));

const FRAMES = 1200;
const PROF = path.resolve(__dirname, '..', '..', '_tools', 'headless', 'prof');

(async () => {
  let bad = 0;
  const rows = [];
  for (let i = 0; i < 20; i++) {
    let file = path.join(PROF, `_rounds_census_${process.pid}_${i}.jsonl`);
    try {
      const m = new Match();
      const info = await recordEpisode(m, { frames: FRAMES, out: file });
      await m.close();
      const rec = readRecording(file);
      let prev = null, runs = 0, roundStarts = 0, inRoundFrames = 0;
      const states = {};
      for (const f of rec.frames) {
        const st = String(f.st);
        states[st] = (states[st] || 0) + 1;
        if (st !== prev) runs++;
        if (st.indexOf('in round') >= 0) { inRoundFrames++; if (prev === null || prev.indexOf('in round') < 0) roundStarts++; }
        prev = st;
      }
      const row = { i, frames: rec.frames.length, recFrames: info.frames, roundStateRuns: runs, roundStarts, inRoundFrames, states: states };
      rows.push(row);
      console.log(JSON.stringify(row));
      if (rec.frames.length !== FRAMES || roundStarts < 2) bad++;
    } catch (e) {
      bad++;
      console.log(JSON.stringify({ i, error: String((e && e.stack) || e).slice(0, 400) }));
    } finally {
      try { if (fs.existsSync(file)) fs.unlinkSync(file); } catch (eUnlink) {}
    }
  }
  const minRounds = Math.min.apply(null, rows.map((r) => r.roundStarts));
  console.log(JSON.stringify({ done: true, iters: 20, bad, minRoundStarts: minRounds,
    minFrames: Math.min.apply(null, rows.map((r) => r.frames)) }));
  process.exit(bad === 0 ? 0 : 1);
})().catch((e) => { console.error('census error:', (e && e.stack) || e); process.exit(1); });
