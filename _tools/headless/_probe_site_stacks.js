'use strict';
const { Match } = require('./match');
const { recordEpisode } = require('./record');
(async () => {
  const origOpen = Match.prototype.open;
  Match.prototype.open = async function (opts) {
    const r = await origOpen.call(this, opts);
    if (opts && opts.rng === 'record') await this.eval('window.__vtRng.debugStacks(true)');
    return r;
  };
  const m = new Match();
  await recordEpisode(m, { frames: 200, out: 'prof/detfix/stack_probe_rec.jsonl' });
  const stacks = await m.eval('window.__vtRng.stacks()');
  await m.close();
  const keys = process.argv.slice(2);
  const out = {};
  for (const k of keys) out[k] = stacks[k] || null;
  console.log(JSON.stringify(out, null, 2));
})().catch((e) => { console.error('FAILED:', (e && e.stack) || e); process.exitCode = 1; });
