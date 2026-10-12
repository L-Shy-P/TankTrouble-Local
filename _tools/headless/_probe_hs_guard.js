'use strict';
/* 证明「拆分没有把真回归放过」：
 *   A. 合成注入：
 *      A1. 改一帧的 hs（决定性隐藏字段：col / rnd）→ 必须 FAIL(hiddenMismatch>0)
 *      A2. 改一帧的 hx（观测性：tf / pg）     → 必须 PASS，仅 hiddenObsMismatch>0
 *      A3. 改一帧的坦克 x 坐标（可见回归）    → 必须 FAIL(poseMismatch>0)
 *      A4. 把 hx 塞回 hs、模拟旧格式（v≤3），再改观测字段 → 仍必须 PASS（legacy 白名单）
 *   B. 端到端注入：回放时在第 60 帧把 tank_a 挪 3 格 → compareFrames 必须 FAIL
 *
 *   node _tools/headless/_probe_hs_guard.js --frames 300
 */
const path = require('path');
const { Match } = require('./match');
const { recordEpisode, replayEpisode, readRecording, compareFrames } = require('./record');

const argv = process.argv.slice(2);
const num = (n, d) => { const i = argv.indexOf('--' + n); return i < 0 ? d : Number(argv[i + 1]); };
const FRAMES = num('frames', 300);
const DIR = path.join(__dirname, 'prof', 'detfix');

let lastNudge = null;
const origCloseGuard = Match.prototype.close;
Match.prototype.close = async function () {
  try { if (this.__wantNudge) lastNudge = await this.eval('window.__nudgeResult || null'); } catch (e) {}
  return origCloseGuard.call(this);
};

const clone = (x) => JSON.parse(JSON.stringify(x));
function brief(c) {
  return { ok: c.ok, hidden: c.hiddenMismatch, hiddenObs: c.hiddenObsMismatch,
           op: c.opMismatch, pose: c.poseMismatch, proj: c.projMismatch, rng: c.rngMismatch,
           state: c.stateMismatch, drive: c.driveMismatch, time: c.timeMismatch, maxPoseDiff: c.maxPoseDiff };
}

(async () => {
  const recFile = path.join(DIR, 'hsguard_rec.jsonl');
  const repFile = path.join(DIR, 'hsguard_rep.jsonl');
  const m = new Match();
  await recordEpisode(m, { frames: FRAMES, ids: ['tank_a', 'tank_b'], out: recFile });
  await m.close();
  const rec = readRecording(recFile);
  await replayEpisode(rec, { out: repFile });
  const rep = readRecording(repFile);
  const base = compareFrames(rec.frames, rep.frames, 'base');
  const results = { frames: FRAMES, baseline: brief(base) };
  if (!base.ok) { console.log(JSON.stringify({ ok: false, why: 'baseline not clean', baseline: results.baseline })); process.exitCode = 1; return; }

  // A1: hs.col（决定性）改动
  let A = clone(rep.frames);
  const f1 = Math.floor(A.length / 2);
  A[f1].hs = Object.assign({}, A[f1].hs, { col: ((A[f1].hs && A[f1].hs.col) || 0) + 7 });
  results.mutate_hs_col = brief(compareFrames(rec.frames, A, 'mut-hs-col'));

  // A1b: hs.rnd（决定性）改动
  A = clone(rep.frames);
  A[f1].hs = Object.assign({}, A[f1].hs, { rnd: [(A[f1].hs.rnd ? A[f1].hs.rnd[0] : 0) + 0.123, 0, 0, 0] });
  results.mutate_hs_rnd = brief(compareFrames(rec.frames, A, 'mut-hs-rnd'));

  // A2: hx（观测性）改动
  A = clone(rep.frames);
  A[f1].hx = Object.assign({}, A[f1].hx, { tf: ((A[f1].hx && A[f1].hx.tf) || 0) + 99 });
  results.mutate_hx_tf = brief(compareFrames(rec.frames, A, 'mut-hx-tf'));

  // A3: 可见位姿改动
  A = clone(rep.frames);
  let moved = false;
  for (let i = 0; i < A.length; i++) {
    const t = (A[i].tanks || []).find((x) => x.id === 'tank_a');
    if (t) { t.x = +t.x + 0.5; moved = true; break; }
  }
  results.mutate_visible_pose = Object.assign({ moved: moved }, brief(compareFrames(rec.frames, A, 'mut-pose')));

  // A4: 老格式兼容（把 hx 合回 hs，再改观测字段）
  A = clone(rep.frames);
  for (const fr of A) {
    if (fr.hx) { fr.hs = Object.assign({}, fr.hs, fr.hx); delete fr.hx; }
  }
  A[f1].hs = Object.assign({}, A[f1].hs, { q: { q: 'low', fps: 999, n: 999 } });
  results.legacy_obs_ignored = brief(compareFrames(rec.frames, A, 'legacy-obs'));
  // A4b: 老格式里决定性字段仍旧要抓
  const B = clone(A);
  B[f1].hs = Object.assign({}, B[f1].hs, { rc: 'MUT-RC' });
  results.legacy_det_caught = brief(compareFrames(rec.frames, B, 'legacy-det'));

  // B: 端到端注入（回放时挪 tank_a）
  const origOpen = Match.prototype.open;
  Match.prototype.open = async function (opts) {
    const r = await origOpen.call(this, opts);
    if (opts && (opts.rngSites || opts.rngSeq)) {
      await this.eval(`(() => {
        var n = 0;
        window.__vtAfter.push(function () {
          n++;
          if (n < 60 || window.__nudgeDone) return;
          try {
            var gc = GameManager.getGameController();
            var ids = ['tank_a', 'tank_b'];
            for (var qi = 0; qi < ids.length; qi++) {
              var t = gc && gc.getTank(ids[qi]);
              if (!t) continue;
              var x0 = t.getX(), y0 = t.getY(), rot = t.getRotation();
              // 逐个偏移试，直到读回位置真的变了（+3 可能落墙里被纠正回去）
              var offs = [[3, 3], [-3, 3], [3, -3], [-3, -3], [1.5, 0], [0, 1.5], [-1.5, 0], [0, -1.5]];
              for (var k = 0; k < offs.length; k++) {
                try {
                  var ts = TankState.withState(ids[qi], x0 + offs[k][0], y0 + offs[k][1], false, false, rot, false, false, false, false);
                  gc.setTankState(ts, false);
                } catch (e2) {}
                var t2 = gc.getTank(ids[qi]);
                if (t2 && (Math.abs(t2.getX() - x0) > 0.01 || Math.abs(t2.getY() - y0) > 0.01)) {
                  window.__nudgeDone = true;
                  window.__nudgeResult = { n: n, id: ids[qi], from: [x0, y0], to: [t2.getX(), t2.getY()], off: offs[k] };
                  return;
                }
              }
            }
            if (n > 140) { window.__nudgeDone = true; window.__nudgeResult = { err: 'no movable tank by n=' + n }; }
          } catch (e) { window.__nudgeDone = true; window.__nudgeResult = { err: String((e && e.message) || e) }; }
        });
        return 'installed';
      })()`);
    }
    return r;
  };
  const repFile2 = path.join(DIR, 'hsguard_rep_injected.jsonl');
  Match.prototype.__wantNudge = true; lastNudge = null;
  await replayEpisode(rec, { out: repFile2 });
  Match.prototype.__wantNudge = false;
  Match.prototype.open = origOpen;
  const rep2 = readRecording(repFile2);
  results.e2e_injected = brief(compareFrames(rec.frames, rep2.frames, 'e2e-injected'));
  results.nudgeResult = lastNudge;
  results.e2e_injected = brief(compareFrames(rec.frames, rep2.frames, 'e2e-injected'));
  // 从回放页面里把 nudge 结果留下来（另起一次短 replay 太贵，直接读注入文件里的 meta 不够，所以这里再补一次小 open 读取）
  try {
    const m3 = new Match();
    await m3.open(Object.assign({}, (rec.header.init && rec.header.init.bootstrap) || {}, {
      rng: 'play', rngSeq: rec.rng, rngSites: rec.rngSites, control: false,
      bootFrames: 300, epoch: rec.header.init ? rec.header.init.vtEpoch : undefined,
      humanIds: ['tank_a', 'tank_b'], aiCount: 0, vantCount: 0,
    }));
    results.nudgeProbe = await m3.eval('window.__nudgeResult || null');
    await m3.close();
  } catch (e) { results.nudgeProbe = 'ERR ' + String(e && e.message || e); }

  console.log(JSON.stringify(results, null, 1));
  // 判定
  const checks = {
    hs_col_caught: !results.mutate_hs_col.ok && results.mutate_hs_col.hidden > 0,
    hs_rnd_caught: !results.mutate_hs_rnd.ok && results.mutate_hs_rnd.hidden > 0,
    hx_tf_ignored: results.mutate_hx_tf.ok && results.mutate_hx_tf.hiddenObs > 0,
    visible_caught: !results.mutate_visible_pose.ok && results.mutate_visible_pose.pose > 0,
    legacy_obs_ignored: results.legacy_obs_ignored.ok,
    legacy_det_caught: !results.legacy_det_caught.ok && results.legacy_det_caught.hidden > 0,
    e2e_caught: !results.e2e_injected.ok,
  };
  const allOk = Object.values(checks).every(Boolean);
  console.log('CHECKS ' + JSON.stringify(checks) + ' => ' + (allOk ? 'ALL_PASS' : 'FAIL'));
  if (!allOk) process.exitCode = 1;
})().catch((e) => { console.error('FAILED:', (e && e.stack) || e); process.exitCode = 1; });
