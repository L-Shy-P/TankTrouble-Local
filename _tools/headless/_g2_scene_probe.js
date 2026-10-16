/**
 * _g2_scene_probe.js —— G2 证据探针（子代理 2026-10-17）
 * ==========================================================================
 * 判据（全部要真跑，⛔ 不看语法）：
 *  ① 多 Laika 实例：`1 vs 3`（players=4）⟹ out.aiIds 有 3 个【不同】id，且【都在动】；
 *  ② 地图联动：players=2/4/8 各开一局，读原版 getMaze 的实测宽高 vs 公式区间；
 *  ③ 毒雾开关：storm=true ⟹ 场上真出现 STORM zone（源：BootCamp 无生成路径，
 *     由 Match.open() 照 ClassicGameMode.update 那一句注入）；storm=false ⟹ 无；
 *  ④ 道具开关：crates=[0..6] 会刷箱；crates=[] 不刷箱。
 *
 * ⛔ 不驱动策略服务端、不碰 game_core、不改建图；产出写 D:/vt_run/g2/。
 * 用法：node _tools/headless/_g2_scene_probe.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

// ⚠️ pyserver.js 的日志走 os.tmpdir()（= C:）⟹ 显式把 TMP/TEMP 指到 D:（纪律 2c）
try {
  fs.mkdirSync('D:/vt_run/tmp', { recursive: true });
  process.env.TMP = 'D:/vt_run/tmp';
  process.env.TEMP = 'D:/vt_run/tmp';
  process.env.VT_TMP_DIR = 'D:/vt_run';
} catch (e) {}

const { Match } = require('./match');

const OUT = process.env.G2_OUT || 'D:/vt_run/g2';
fs.mkdirSync(OUT, { recursive: true });
const say = (s) => console.log(s);

const EXPECT = { 2: { W: [6, 8], H: [4, 5] }, 4: { W: [10, 14], H: [6, 8] }, 8: { W: [14, 16], H: [8, 10] } };

function moveStats(frames, ids) {
  const out = {};
  for (const id of ids) {
    const ps = [];
    for (const fr of frames) {
      const t = fr.tanks.find((x) => x.id === id);
      if (t) ps.push(t);
    }
    let motionFrames = 0, dist = 0, maxStep = 0;
    const uniq = new Set();
    for (let i = 0; i < ps.length; i++) {
      uniq.add(ps[i].x.toFixed(3) + ',' + ps[i].y.toFixed(3) + ',' + ps[i].rot.toFixed(5));
      if (i > 0) {
        const d = Math.hypot(ps[i].x - ps[i - 1].x, ps[i].y - ps[i - 1].y);
        if (d > 1e-9) motionFrames++;
        dist += d;
        if (d > maxStep) maxStep = d;
      }
    }
    let firedFirst = null, firedLast = null;
    for (let i = 0; i < frames.length; i++) {
      const w = frames[i].weapons.find((x) => x.owner === id);
      if (w && w.fired !== null && w.fired !== undefined) {
        if (firedFirst === null) firedFirst = w.fired;
        firedLast = w.fired;
      }
    }
    out[id] = {
      frames: ps.length, motion_frames: motionFrames, unique_poses: uniq.size,
      path_len: +dist.toFixed(2), max_step: +maxStep.toFixed(3),
      fired_first: firedFirst, fired_last: firedLast,
      moving: (motionFrames > 0 && uniq.size > 1 && dist > 0.01),
      first: ps.length ? ps[0] : null, last: ps.length ? ps[ps.length - 1] : null,
    };
  }
  return out;
}

/** 开一局、采样 frames 帧；返回证据对象 */
async function runScene(tag, opts, frames, sampleEvery) {
  const m = new Match();
  const ev = { tag, opts, boot: null, maze: null, frames: 0, players: [], per_player: null, end: null, err: null };
  try {
    await m.open(Object.assign({ humanIds: [], control: false }, opts));
    ev.boot = m.bootstrap;
    ev.stormFlag = m.stormFlag || null;
    ev.stormSpawn = m.stormSpawn || null;
    ev.maze = await m.maze();
    const mazeIds = (ev.maze.tankPositions || []).map((p) => p && p.playerId).filter(Boolean);
    ev.players = mazeIds.length ? mazeIds : (await m.snapshot()).tanks.map((t) => t.id);
    const fr = [];
    const every = sampleEvery || 1;
    let maxCrates = 0, stormFrames = 0, nSamples = 0;
    for (let f = 0; f < frames; f++) {
      const s = await m.snapshot();
      if (f % every === 0) {
        fr.push({ t: f, tanks: s.tanks.map((t) => ({ id: t.id, x: t.x, y: t.y, rot: t.rot })),
                  collectibles: s.collectibles,
                  weapons: s.weapons.map((w) => ({ owner: w.owner, fired: w.fired })) });
        const ss = await m.stormState();
        nSamples++;
        if (ss && ss.nStorm > 0) stormFrames++;
        const cc = (await m.eval('(()=>{var gc=GameManager.getGameController();return gc&&gc.getCollectibles?__vtArr(gc.getCollectibles()).length:-1})()'));
        if (cc > maxCrates) maxCrates = cc;
      }
      await m.pump(1, { yieldMs: 0 });
    }
    ev.frames = frames;
    ev.per_player = moveStats(fr, ev.players);
    ev.samples = { every, n: nSamples, storm_zone_frames: stormFrames, max_collectibles: maxCrates };
    ev.end = await m.snapshot().catch(() => null);
    ev.quality = {
      ai_ids: (ev.boot && ev.boot.aiIds) || [],
      ai_ids_distinct: new Set((ev.boot && ev.boot.aiIds) || []).size,
      vantage_ids: (ev.boot && ev.boot.vantageIds) || [],
      maxActivePlayerCount: ev.boot && ev.boot.maxActivePlayerCount,
      crateTypesLen: ev.boot && ev.boot.crateTypes ? ev.boot.crateTypes.length : null,
      page_errors: m.pageErrors.slice(0, 3),
    };
  } catch (e) {
    ev.err = String((e && e.stack) || e);
  } finally {
    try { await m.close(); } catch (e) { ev.closeErr = String(e); }
  }
  return ev;
}

(async () => {
  const rep = { ts: new Date().toISOString(), expect: EXPECT, scenes: [] };
  // ② 地图联动 + ① 1v3 多实例（players=4 多采一点帧数）
  for (const [p, frames] of [[2, 240], [4, 480], [8, 240]]) {
    const ev = await runScene('players' + p, { players: p, storm: false, crates: [] }, frames, 1);
    rep.scenes.push(ev);
    const exp = EXPECT[p];
    const okW = ev.maze && ev.maze.width >= exp.W[0] && ev.maze.width <= exp.W[1];
    const okH = ev.maze && ev.maze.height >= exp.H[0] && ev.maze.height <= exp.H[1];
    say('SCENE players=' + p + ' err=' + (ev.err ? ev.err.split('\n')[0] : 'null') +
        ' aiIds=' + JSON.stringify(ev.quality.ai_ids) + ' distinct=' + ev.quality.ai_ids_distinct +
        ' map=' + (ev.maze ? ev.maze.width + 'x' + ev.maze.height : '?') +
        ' expectW=' + JSON.stringify(exp.W) + ' expectH=' + JSON.stringify(exp.H) +
        ' W_in=' + okW + ' H_in=' + okH + ' maxActive=' + ev.quality.maxActivePlayerCount);
  }
  // ① 多实例"都在动"的逐 id 统计（players=4 那局）
  const p4 = rep.scenes.find((s) => s.tag === 'players4');
  if (p4 && p4.per_player) {
    for (const id of Object.keys(p4.per_player)) {
      const s = p4.per_player[id];
      say('MOTION ' + id + ' motion_frames=' + s.motion_frames + ' uniq=' + s.unique_poses +
          ' path=' + s.path_len + ' fired=' + s.fired_first + '->' + s.fired_last + ' moving=' + s.moving);
    }
  }
  // ① 加一局 1v3 且带毒雾/道具（同时也验 ③④）
  const st = await runScene('p4_storm_crates', { players: 4, storm: true, crates: [0, 1, 2, 3, 4, 5, 6] }, 900, 5);
  rep.scenes.push(st);
  say('SCENE p4_storm_crates err=' + (st.err ? st.err.split('\n')[0] : 'null') +
      ' stormSpawn=' + JSON.stringify(st.stormSpawn) + ' stormZoneFrames=' + (st.samples && st.samples.storm_zone_frames) +
      '/' + (st.samples && st.samples.n) + ' maxCollectibles=' + (st.samples && st.samples.max_collectibles));
  // ③④ 对照：关毒雾 + 关道具
  const ctl = await runScene('p4_clear_nocrate', { players: 4, storm: false, crates: [] }, 600, 5);
  rep.scenes.push(ctl);
  say('SCENE p4_clear_nocrate err=' + (ctl.err ? ctl.err.split('\n')[0] : 'null') +
      ' stormZoneFrames=' + (ctl.samples && ctl.samples.storm_zone_frames) + '/' + (ctl.samples && ctl.samples.n) +
      ' maxCollectibles=' + (ctl.samples && ctl.samples.max_collectibles));

  fs.writeFileSync(path.join(OUT, 'scene_probe.json'), JSON.stringify(rep, null, 1));
  say('OUT ' + path.join(OUT, 'scene_probe.json'));
})().catch((e) => { say('FATAL ' + ((e && e.stack) || e)); process.exit(1); });
