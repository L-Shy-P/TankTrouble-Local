/**
 * G1 主驱动 —— 「Vantage 打 Laika 跑通一整局」
 * ==========================================================================
 * 结构照抄 `_slowframe_tmp.js`（它就是"起服务端 + 开对局 + 每帧打听策略 + 喂回页面"的完整循环）。
 *
 * 每帧一步：
 *   ① 页面内 `window.__g1.step(nodeId)`：读观测（真树 + 真适配器）+ 写回上一帧策略给的 nodeId
 *   ② 上行给策略服务端：`{N, seed, segs:{node,opp,global}}`（一问一答、逐行读）
 *   ③ 下落回页面（下一帧生效），再泵 1 帧
 * 全程记账：双方位姿 / 弹丸归属 / 武器开火数 / 每帧提交的输入 / 树提交节点 / lp·v·nodeId
 *
 * ⛔ 不改任何产品代码；⛔ 不改 `policy_server_graph.py`；产出全写 `D:/vt_run/g1/`。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { Match } = require('./match');

const REPO = path.resolve(__dirname, '..', '..');
const OUT = process.env.G1_OUT || 'D:/vt_run/g1';
const MAXF = Number(process.env.G1_MAX_FRAMES || 12000);
const MAXS = Number(process.env.G1_MAX_SEC || 780);
const TAG = process.env.G1_TAG || 'run';
const SRC = fs.readFileSync(path.join(__dirname, '_g1_inject.js'), 'utf8');
fs.mkdirSync(OUT, { recursive: true });

const say = (s) => console.log(s);

/** 逐行读服务端 stdout 的客户端（一问一答；⛔ 不改服务端，只是把"一次 data 事件"拼成整行） */
class Srv {
  constructor() {
    this.p = spawn('py', ['-3.13', '_tools/training/policy_server_graph.py'],
      { cwd: REPO, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
    this.buf = ''; this.q = []; this.waiters = []; this.boot = []; this.err = [];
    this.p.stdout.setEncoding('utf8');
    this.p.stdout.on('data', (d) => {
      this.buf += d; let i;
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i); this.buf = this.buf.slice(i + 1);
        if (this.waiters.length) this.waiters.shift()(line); else this.q.push(line);
      }
    });
    this.p.stderr.setEncoding('utf8');
    this.p.stderr.on('data', (d) => {
      String(d).split('\n').forEach((l) => { if (l.trim()) { this.err.push(l); say('SRV_STDERR ' + l); } });
    });
    this.p.on('exit', (c) => say('SRV_EXIT code=' + c));
  }
  line(ms) {
    if (this.q.length) return Promise.resolve(this.q.shift());
    return new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('等服务端一行超时(' + ms + 'ms)')), ms || 60000);
      this.waiters.push((l) => { clearTimeout(t); res(l); });
    });
  }
  async ask(o) { this.p.stdin.write(JSON.stringify(o) + '\n'); return JSON.parse(await this.line(60000)); }
  async bootUntil(mark, maxLines) {
    for (let i = 0; i < (maxLines || 12); i++) {
      const l = await this.line(120000);
      this.boot.push(l); say('SRV_BOOT ' + l.slice(0, 120));
      if (l.indexOf(mark) >= 0) return i + 1;
    }
    throw new Error('开机 ' + maxLines + ' 行里没出现 ' + mark);
  }
  async close() {
    try { this.p.stdin.end(); } catch (e) { }
    await new Promise((r) => { const k = setTimeout(() => { try { this.p.kill(); } catch (e) { } r(); }, 3000); this.p.on('exit', () => { clearTimeout(k); r(); }); });
  }
}

const DIST = (a, b) => (a && b) ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
const key = (t) => t ? (t.x + ',' + t.y + ',' + t.rot) : 'null';

(async () => {
  const wall0 = Date.now();
  const srv = new Srv();
  let m = null, endReason = '', rows = [], stepErrs = [];
  try {
    const nBoot = await srv.bootUntil('WARMUP_SAMPLE', 12);
    say('BOOT_LINES ' + nBoot);
    m = new Match();
    await m.open({ humanIds: [], aiCount: 1, vantCount: 1, control: false });
    say('BOOTSTRAP ' + JSON.stringify(m.bootstrap));
    await m.eval(SRC);
    say('SUBSCRIBE ' + await m.eval('window.__g1.subscribe()'));
    const meta = JSON.parse(await m.eval('JSON.stringify(window.__g1.meta())'));
    say('META ' + JSON.stringify(meta));
    const players0 = meta.players.slice();
    const vet = { vid: meta.vid, aiId: players0.find((p) => p !== meta.vid) || null, t: meta.states.IN_ROUND };
    say('VANTAGE_ID ' + vet.vid + '  OPP_ID ' + vet.aiId);

    say('SETUP ' + await m.eval('window.__g1.setup()'));
    say('SETFIRE ' + await m.eval('window.__g1.setFire(' + (process.env.G1_FIRE === '1' ? '1' : '0') + ')'));

    let nodeId = 0, nAsk = 0, nZeroN = 0, nSubNonZero = 0, nSrvErr = 0, lpFinite = 0, oob = 0, lastKills = 0;
    const hashes = new Set(), nids = new Set(), srvErrs = [];
    const firstLast = {};
    const tLoop0 = Date.now();
    for (let f = 0; f < MAXF; f++) {
      const tA = Date.now();
      let o;
      try { o = JSON.parse(await m.eval('window.__g1.step(' + nodeId + ')')); }
      catch (e) { stepErrs.push('f=' + f + ' ' + String(e.message || e)); break; }
      const tB = Date.now();
      if (o.err) { stepErrs.push('f=' + f + ' ' + o.err); break; }
      if (o.kills && o.kills.length > (lastKills || 0)) { say('KILL_EVT ' + JSON.stringify(o.kills.slice(lastKills || 0))); lastKills = o.kills.length; }

      let p = null, pErr = null;
      if (o.N >= 1) {
        try { p = await srv.ask({ N: o.N, seed: f + 1, segs: o.segs }); nAsk++; }
        catch (e) { pErr = String(e.message || e); }
      } else nZeroN++;
      const tC = Date.now();
      if (p) { if (p.err) { nSrvErr++; if (srvErrs.length < 5) srvErrs.push(String(p.err).slice(0, 200)); }
               else { if (typeof p.lp === 'number' && isFinite(p.lp)) lpFinite++;
                      if (typeof p.nodeId === 'number' && p.nodeId >= o.N) oob++;
                      if (typeof p.nodeId === 'number') nids.add(p.nodeId); } }
      if (o.h !== undefined && o.h !== null) hashes.add(o.h);
      if (o.sub && (o.sub.f || o.sub.b || o.sub.l || o.sub.r || o.sub.fire)) nSubNonZero++;

      rows.push({ f, ms: { step: tB - tA, ask: tC - tB }, state: o.state, N: o.N, h: o.h,
        lp: p ? p.lp : null, v: p ? p.v : null, a: p ? p.nodeId : null, err: (p && p.err) || pErr || null,
        mode: p ? p.mode : null, payload: p ? p.payload : null,
        projN: o.projN, projBy: o.projBy, wep: o.wep, sub: o.sub, tv: o.tv, tvd: o.dims ? o.dims.nodeStat : null,
        pl: o.pl });
      const nxt = (p && typeof p.nodeId === 'number' && p.nodeId >= 0 && p.nodeId < o.N) ? p.nodeId : nodeId;
      nodeId = nxt;

      await m.pump(1, { yieldMs: 0 });

      // 首末帧位姿留样（判据二的"坐标在变"证据）
      for (const k of [vet.vid, vet.aiId]) {
        if (o.pl && o.pl[k]) { if (!firstLast[k]) firstLast[k] = { first: o.pl[k] }; firstLast[k].last = o.pl[k]; }
      }
      if (f > 3 && o.state && o.state !== vet.t) { endReason = '游戏状态=' + o.state + '（第 ' + f + ' 帧）'; break; }
      if (Date.now() - tLoop0 > MAXS * 1000) { endReason = '到墙钟上限 ' + MAXS + 's（第 ' + f + ' 帧）'; break; }
    }
    if (!endReason) endReason = '到帧数上限 ' + MAXF + ' 帧仍未结束';

    // ── 收尾取证
    const snap = await m.snapshot();
    const meta2 = JSON.parse(await m.eval('JSON.stringify(window.__g1.meta())'));
    const kills = JSON.parse(await m.eval('JSON.stringify(window.__g1.kills)'));
    const roundEnded = JSON.parse(await m.eval('JSON.stringify(window.__g1.roundEnded||null)'));
    const gcStateEnd = await m.eval('GameManager.getGameController().getState()');
    const roundIdEnd = await m.eval('GameManager.getGameController().getRoundId()');
    const tanksAlive = {};
    for (const id of players0) tanksAlive[id] = await m.eval("(()=>{var t=GameManager.getGameController().getTank(" + JSON.stringify(id) + ");return !!t;})()");
    const wallS = +((Date.now() - wall0) / 1000).toFixed(1);

    // ── 统计（判据证据）
    const byId = (id) => rows.map((r) => r.pl && r.pl[id]).filter(Boolean);
    const stat = {};
    for (const id of players0) {
      const ps = byId(id); const ks = new Set(ps.map(key));
      let len = 0, maxd = 0;
      for (let i = 1; i < ps.length; i++) { const d = DIST(ps[i - 1], ps[i]); len += d; if (d > maxd) maxd = d; }
      const projFrames = rows.filter((r) => r.projBy && r.projBy[id] > 0).length;
      const fired = rows.map((r) => (r.wep && r.wep[id]) ? r.wep[id].fired : null).filter((v) => v !== null);
      stat[id] = { frames: ps.length, uniq_pose: ks.size, path_len: +len.toFixed(2), max_step: +maxd.toFixed(2),
        proj_frames: projFrames, fired_first: fired.length ? fired[0] : null, fired_last: fired.length ? fired[fired.length - 1] : null,
        last_pose: ps.length ? ps[ps.length - 1] : null, alive_at_end: tanksAlive[id] };
    }
    const victimSet = new Set(kills.map((k) => k.victim));
    const aliveIds = players0.filter((p) => !victimSet.has(p) && tanksAlive[p]);
    const subFrames = rows.filter((r) => r.sub && (r.sub.f || r.sub.b || r.sub.l || r.sub.r || r.sub.fire)).length;
    const tvCommits = new Set(rows.map((r) => r.tv && r.tv.commitId).filter((v) => v !== null && v !== undefined));
    const tvRoot = rows.filter((r) => r.tv && r.tv.commitIsRoot === true).length;
    const msStep = rows.map((r) => r.ms.step).sort((a, b) => a - b);
    const msAsk = rows.map((r) => r.ms.ask).sort((a, b) => a - b);
    const med = (a) => a.length ? a[Math.floor(a.length / 2)] : null;

    const summary = {
      tag: TAG, wall_sec: wallS, end_reason: endReason,
      frames_recorded: rows.length, frames_asked: nAsk, frames_N0: nZeroN,
      players: players0, vantage_id: vet.vid, opp_id: vet.aiId,
      end_state: snap.stage, gc_state: gcStateEnd, round_id_end: roundIdEnd, scores: snap.scores,
      kills, round_ended_event: roundEnded, tanks_alive_at_end: tanksAlive, alive_ids: aliveIds,
      per_player: stat,
      vantage_submit_nonzero_frames: subFrames,
      tree_commit_ids_seen: tvCommits.size, tree_commit_is_root_frames: tvRoot,
      quality: { lp_finite: lpFinite + '/' + nAsk, lp_finite_ratio: nAsk ? +(lpFinite / nAsk).toFixed(4) : null,
        nodeId_oob: oob, nodeId_in_range: (nAsk - nSrvErr - oob) + '/' + nAsk,
        obs_hash_unique: hashes.size + '/' + rows.length, distinct_nodeIds: nids.size, srv_errors: nSrvErr },
      srv_errors_sample: srvErrs, step_errors: stepErrs,
      server_boot_lines: srv.boot, server_stderr: srv.err,
      page_errors: m.pageErrors.slice(0, 5),
      ms: { step_median: med(msStep), ask_median: med(msAsk) },
    };
    fs.writeFileSync(path.join(OUT, 'frames_' + TAG + '.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    fs.writeFileSync(path.join(OUT, 'summary_' + TAG + '.json'), JSON.stringify(summary, null, 2));

    say('==================== G1 SUMMARY ====================');
    say('END_REASON ' + endReason + '  wall=' + wallS + 's  frames=' + rows.length);
    say('END_STATE stage=' + snap.stage + ' gc_state=' + gcStateEnd + ' roundId=' + roundIdEnd);
    say('ROUND_ENDED ' + JSON.stringify(roundEnded));
    say('KILLS ' + JSON.stringify(kills));
    say('ALIVE_AT_END ' + JSON.stringify(tanksAlive) + ' alive_ids=' + JSON.stringify(aliveIds));
    for (const id of players0) say('PLAYER ' + id + ' ' + JSON.stringify(stat[id]));
    say('VANTAGE_SUBMIT_NONZERO ' + subFrames + '/' + rows.length + '  tree_commit_ids=' + tvCommits.size + ' commitIsRoot_frames=' + tvRoot);
    say('QUALITY ' + JSON.stringify(summary.quality));
    say('MS step_median=' + med(msStep) + ' ask_median=' + med(msAsk));
    say('SRV_ERR_SAMPLE ' + JSON.stringify(srvErrs));
    say('STEP_ERR ' + JSON.stringify(stepErrs));
    say('PAGE_ERRS ' + JSON.stringify(m.pageErrors.slice(0, 3)));
    say('OUT ' + OUT + ' (frames_' + TAG + '.jsonl / summary_' + TAG + '.json)');
  } catch (e) {
    say('FAILED ' + ((e && e.stack) || e));
    process.exitCode = 1;
  } finally {
    try { if (m) await m.close(); } catch (e) { say('CLOSE_ERR ' + e); }
    try { await srv.close(); } catch (e) { }
  }
})();
