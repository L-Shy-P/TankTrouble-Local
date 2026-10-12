'use strict';
/* ============================================================================
 * 实测探针（阶段 1-2 弹种缺项 ① ②）—— 只读产品代码，本文件是【新建的探针】
 *
 *   实验 ①：PROJECTILE_BOUNCE_TIMEOUT_WINDOW = 35 是什么单位？
 *            「反弹满 5 次消失」（Projectile.done() 第三条）到底生不生效？
 *            做法：把 tank_a 放进一条【两侧全封死】的长走廊，朝侧墙垂直打一发普通弹，
 *                  逐帧读 Projectile.bounces（数组本身，不靠数画面）/ timeAlive / lifetime / 速度。
 *            附加：中段把 tank_a 挪走，免得弹飞回来把自己打死（撞墙后 deadlyToOwner=true）。
 *
 *   实验 ②：激光撞墙反不反弹？
 *            做法：给 tank_a 一把激光（gc.setWeaponState(LaserWeapon.createInitialWeaponState(...))，
 *                  和 training_mode.js:applyEmitterWeapon 同一个入口），朝走廊尽头的墙打，
 *                  逐帧读 body 速度向量 / 位置 / bounces。
 *
 *   实验 ③（附加）：炮口顶死墙发射（弹可能生成在墙里）——极限自然场景下
 *                  bounces 会不会在 35ms 内堆到 5？用 tank_b 做，免得弄死 tank_a。
 *
 * 用法：node _tools/headless/_probe_bounce_laser.js
 * 产物：_tools/headless/prof/probe_bl_*.csv（逐帧小表）+ stdout（摘要）
 * ============================================================================ */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Match } = require('./match');

const TILE = 10;
const PROFDIR = path.join(__dirname, 'prof');

/* ---------------- 版本指纹：测的是哪一版代码 ---------------- */
const FILES = [
  'game_core/index.html',
  'game_core/js/418577fd210ad079ea3d1e5e04050fe0.js',   // Projectile/Shotgun/Shrapnel/HomingMissile/Maze
  'game_core/js/b714588dc4621fe104113111ba90b1a7.js',   // Constants + B2DUtils
  'game_core/js/46989e393ad0e356ac8a0c6c53b362f9.js',   // RoundModel
  'game_core/js/82e43ebfcdffdaf490dbe79c9c119d29.js',   // RoundController
  'game_core/js/7b2ed8ad3598d7321f8f3d2b04b1eac8.js',   // Weapon/LaserWeapon/Tank/...
  'game_core/js/vantage_tree.js',
  'game_core/js/vantage_sandbox.js',
  '_tools/headless/match.js',
  '_tools/headless/clock.js',
];
function fingerprints() {
  const out = [];
  for (const rel of FILES) {
    const p = path.join(__dirname, '..', '..', rel);
    try {
      const st = fs.statSync(p);
      const md5 = crypto.createHash('md5').update(fs.readFileSync(p)).digest('hex');
      out.push({ file: rel, bytes: st.size, mtime: st.mtime.toISOString(), md5 });
    } catch (e) { out.push({ file: rel, err: String(e.message || e) }); }
  }
  return out;
}

/* ---------------- 页面内：逐帧采样器 + 撞墙事件监听 ---------------- */
const HELPERS = `
window.__vtEv = [];
window.__vtP = {
  on: false, rows: [], _inst: false, tag: '', hits: [], contact: {},
  r: function (x) { return Math.round(x * 10000) / 10000; },
  install: function () {
    if (this._inst) return 'already';
    this._inst = true;
    var self = this;

    // 每帧【推进后】采样（clock.js 的 __vtAfter）
    window.__vtAfter.push(function () {
      if (!self.on) return;
      var s = self.sample();
      if (s) {
        s.tag = self.tag;
        // 本帧的撞墙/撞盾事件数（来自 RoundModel 事件，pre-prune）
        var n = 0, nbMax = 0, minAge = null;
        for (var i = 0; i < window.__vtEv.length; i++) {
          var e = window.__vtEv[i];
          if (e.f === s.f && (e.evt === 'projectile maze collision' || e.evt === 'projectile shield collision')) {
            n++;
            if (e.nb > nbMax) nbMax = e.nb;
          }
        }
        s.evN = n; s.evNbMax = nbMax;
        self.rows.push(s);
      }
    });

    // 撞墙/撞盾【碰撞点】+ 回合/游戏事件 —— 走游戏自己的事件总线（不碰产品代码）
    var gc = GameManager.getGameController();
    if (!gc) return 'no-gc';

    var summarize = function (evt, data) {
      var o = { evt: evt };
      try {
        if (data && typeof data === 'object') {
          if (data.projectile) {
            var p = data.projectile, b = p.getB2DBody(), v = b ? b.GetLinearVelocity() : null;
            o.id = p.getId(); o.ty = p.getType(); o.owner = p.getPlayerId();
            o.cx = self.r(data.collisionPoint.x); o.cy = self.r(data.collisionPoint.y);
            o.nx = self.r(data.collisionNormal.x); o.ny = self.r(data.collisionNormal.y);
            o.vx = v ? self.r(v.x) : null; o.vy = v ? self.r(v.y) : null;
            o.nb = p.bounces.length;            // ★ push 之后、update() 剪枝【之前】的长度
            o.ta = self.r(p.getTimeAlive());
            o.la = p.lifetime; o.tw = p.timeoutWindow; o.tc = p.timeoutBounceCount;
          }
          if (data.getVictimPlayerId) o.victim = data.getVictimPlayerId();
          if (data.getKillerPlayerId) o.killer = data.getKillerPlayerId();
          if (data.getWeaponType) o.weapon = data.getWeaponType();
          if (data.getPlayerId) o.playerId = data.getPlayerId();
          if (data.getPlayerIds) o.playerIds = data.getPlayerIds();
          if (data.getId) o.objId = data.getId();
        } else if (typeof data === 'string' || typeof data === 'number') { o.data = data; }
      } catch (e) { o.err = String(e && e.message || e); }
      return o;
    };

    // (a) 回合级事件：注册到 RoundModel 上（gc.addEventListener 注册的是【游戏级】事件，抓不到撞墙）
    var rmodel = gc.roundController && gc.roundController.model;
    if (rmodel && rmodel.addEventListener) {
      rmodel.addEventListener(function (ctx, gid, evt, data) {
        window.__vtEv.push(Object.assign({ f: window.__vt.steps, t: window.__vt.t, k: 'round' }, summarize(evt, data)));
      }, null, gc.getId());
      window.__vtEvBus = { round: true, game: false };
    }
    if (gc.addEventListener) {
      gc.addEventListener(function (ctx, gid, evt, data) {
        window.__vtEv.push(Object.assign({ f: window.__vt.steps, t: window.__vt.t, k: 'game' }, summarize(evt, data)));
      }, null, gc.getId());
      window.__vtEvBus.game = true;
    }
    return 'installed ' + JSON.stringify(window.__vtEvBus);
  },
  sample: function () {
    var gc = GameManager.getGameController();
    if (!gc) return null;
    var nowMs = window.__vt.epoch + window.__vt.t;   // = 本帧 new Date().getTime()
    var ps = gc.getProjectiles();
    var arr = [];
    for (var k in ps) {
      var p = ps[k];
      var b = p.getB2DBody();
      var v = b ? b.GetLinearVelocity() : null;
      var bs = [];
      for (var i = 0; i < p.bounces.length; i++) {
        bs.push(Math.round((p.bounces[i] - nowMs) * 100) / 100);   // 相对本帧的“年龄(ms)”
      }
      arr.push({
        id: k, o: p.getPlayerId(), ty: p.getType(),
        x: this.r(p.getX()), y: this.r(p.getY()),
        vx: v ? this.r(v.x) : null, vy: v ? this.r(v.y) : null,
        sp: v ? this.r(v.Length()) : null,
        ta: this.r(p.getTimeAlive()), la: p.lifetime,
        tw: p.timeoutWindow, tc: p.timeoutBounceCount,
        st: p.stopped, dto: p.isDeadlyToOwner(),
        nb: p.bounces.length, bs: bs
      });
    }
    var tk = [];
    var ts = gc.getTanks();
    for (var id in ts) tk.push({ id: id, x: this.r(ts[id].getX()), y: this.r(ts[id].getY()) });
    return { f: window.__vt.steps, t: Math.round(window.__vt.t * 100) / 100, p: arr, tk: tk, alive: tk.length };
  },
  chunk: function (from, n) { return this.rows.slice(from, from + n); },
  clear: function () { var n = this.rows.length; this.rows = []; this.hits = []; return n; }
};
window.__vtProjCount = function (ty) {
  var gc = GameManager.getGameController();
  var ps = gc.getProjectiles(), n = 0;
  for (var k in ps) { if (ty === undefined || ps[k].getType() === ty) n++; }
  return n;
};
`;

/* ---------------- Node 侧小工具 ---------------- */
const key = (x, y) => x + ',' + y;

/** 找「两侧全封死」的走廊。horiz=true → 沿 x 走、上下是墙。返回 {x0,y0,len,horiz} */
function findCorridor(openSet, W, H, horiz) {
  let best = null;
  if (horiz) {
    for (let y = 0; y < H; y++) {
      let run = 0, start = -1;
      for (let x = 0; x <= W; x++) {
        const sealed = x < W && openSet.has(key(x, y)) &&
          !openSet.has(key(x, y - 1)) && !openSet.has(key(x, y + 1));
        if (sealed) { if (run === 0) start = x; run++; }
        else {
          if (run > (best ? best.len : 0)) best = { x0: start, y0: y, len: run, horiz: true };
          run = 0;
        }
      }
    }
  } else {
    for (let x = 0; x < W; x++) {
      let run = 0, start = -1;
      for (let y = 0; y <= H; y++) {
        const sealed = y < H && openSet.has(key(x, y)) &&
          !openSet.has(key(x - 1, y)) && !openSet.has(key(x + 1, y));
        if (sealed) { if (run === 0) start = y; run++; }
        else {
          if (run > (best ? best.len : 0)) best = { x0: x, y0: start, len: run, horiz: false };
          run = 0;
        }
      }
    }
  }
  return best;
}

/** 找一条「直道尽头是墙」的跑道（实验②激光用）：
 *  坦克在格 T 的格心，朝 dir 打；T+2dir 仍是地板，T+3dir 是墙 → 中间没有阻挡，
 *  墙内表面距枪口约 22.1m。返回 {rot,dir,tank,wallInner,dist} */
function findLane(openSet, mz) {
  const DIRS = [
    { dx: 1, dy: 0, rot: Math.PI / 2, name: '+x' },
    { dx: -1, dy: 0, rot: -Math.PI / 2, name: '-x' },
    { dx: 0, dy: 1, rot: Math.PI, name: '+y' },
    { dx: 0, dy: -1, rot: 0, name: '-y' },
  ];
  let best = null;
  for (const r of mz.reachable) {
    for (const d of DIRS) {
      if (!openSet.has(key(r.x + 2 * d.dx, r.y + 2 * d.dy))) continue;  // 中间两格必须是地板
      if (openSet.has(key(r.x + 3 * d.dx, r.y + 3 * d.dy))) continue;  // 第 3 格必须是墙
      const cx = r.x * TILE + TILE / 2, cy = r.y * TILE + TILE / 2;
      let inner;
      if (d.dx > 0) inner = (r.x + 3) * TILE - 0.4;
      else if (d.dx < 0) inner = (r.x - 2) * TILE + 0.4;
      else if (d.dy > 0) inner = (r.y + 3) * TILE - 0.4;
      else inner = (r.y - 2) * TILE + 0.4;
      const wall = d.dx ? { x: inner, y: cy } : { x: cx, y: inner };
      const muzzle = d.dx ? cx + 2.5 * d.dx : cy + 2.5 * d.dy;
      const dist = Math.abs(inner - muzzle);
      const cand = { rot: d.rot, dir: d.name, tank: { x: cx, y: cy }, wallInner: wall,
                     dist: Math.round(dist * 100) / 100, tile: [r.x, r.y] };
      if (!best || cand.dist > best.dist) best = cand;
    }
  }
  return best;
}


function writeCsv(file, rows) {
  fs.writeFileSync(file, rows.join('\n') + '\n');
  return { file, rows: rows.length, bytes: fs.statSync(file).size };
}

/** 导出页面里累积的逐帧行 */
async function dumpRows(m, maxChunk = 200) {
  const rows = [];
  for (let from = 0; ; from += maxChunk) {
    const part = await m.eval(`window.__vtP.chunk(${from}, ${maxChunk})`);
    if (!Array.isArray(part) || part.length === 0) break;
    for (const r of part) rows.push(r);
    if (part.length < maxChunk) break;
  }
  return rows;
}

/* ---------------- 回合就绪守卫（回合被结束/重开时，tanks 会被清空 → 必须响亮报出来） ---------------- */
async function roundInfo(m) {
  return m.eval(`(() => {
    var gc = GameManager.getGameController();
    var inRound = (typeof GameModel !== 'undefined' && GameModel._STATES) ? GameModel._STATES.IN_ROUND : 'in round';
    if (!gc) return { gc: null, inRound: inRound };
    var tks = gc.getTanks() || {};
    var ids = []; for (var k in tks) ids.push(k);
    return { gc: gc.getState(), inRound: inRound, tanks: ids, roundId: gc.getRoundId ? gc.getRoundId() : null,
             projs: Object.keys(gc.getProjectiles() || {}).length, mz: !!gc.getMaze() };
  })()`);
}
async function requireRound(m, tag, P) {
  let info = await roundInfo(m);
  P(`  [守卫 ${tag}] ${JSON.stringify(info)}`);
  if (info.gc !== info.inRound || !info.tanks || info.tanks.length < 2) {
    P(`  !! [守卫 ${tag}] 回合不在进行中或坦克不全 —— 尝试 waitForRound 重等`);
    await m.waitForRound({ roundMaxFrames: 1500 }).catch((e) => P('  waitForRound 失败: ' + e.message));
    info = await roundInfo(m);
    P(`  [守卫 ${tag} 重等后] ${JSON.stringify(info)}`);
  }
  return info;
}

/* ---------------- 主流程 ---------------- */
(async () => {
  let m = new Match();
  const report = { fingerprints: fingerprints(), steps: [] };
  const P = (s) => console.log(s);
  const T0 = Date.now();
  let mz = null, openSet = null;

  try {
    P('=== 版本指纹 ===');
    for (const f of report.fingerprints) P(`  ${f.file}  mtime=${f.mtime}  md5=${f.md5}  bytes=${f.bytes}`);

    /* ---- 开对局：随机图不合适就【重开一局】重抽（每局约 3~15s） ---- */
    let hc = null, vc = null, lane = null, cc = null, far = null, attempts = 0;
    for (attempts = 1; attempts <= 10; attempts++) {
      if (attempts > 1) { try { await m.close(); } catch (e) {} m = new Match(); }
      P(`
=== 开对局（第 ${attempts} 次尝试；空场：tank_a + tank_b，无 AI） ===`);
      const tOpen = Date.now();
      await m.open({ humanIds: ['tank_a', 'tank_b'], aiCount: 0, vantCount: 0 });
      P(`  open 用时 ${((Date.now() - tOpen) / 1000).toFixed(1)}s，waitForRound=${JSON.stringify(m.roundWait)}`);
      await m.eval(HELPERS);
      P('  采样器: ' + (await m.eval('window.__vtP.install()')));

      mz = await m.maze();
      openSet = new Set(mz.reachable.map((r) => key(r.x, r.y)));
      P(`  迷宫 ${mz.width}x${mz.height}，可达 ${mz.reachable.length} 格`);

      hc = findCorridor(openSet, mz.width, mz.height, true);
      vc = findCorridor(openSet, mz.width, mz.height, false);
      lane = findLane(openSet, mz);
      P(`  水平走廊(两侧封死)=${JSON.stringify(hc)}  垂直走廊=${JSON.stringify(vc)}  激光跑道=${JSON.stringify(lane)}`);

      if ((hc || vc) && lane) break;
      P('  !! 这张图不够用（需要「两侧封死的走廊」+「一条尽头是墙的直道」）→ 重开一局');
    }
    report.mapAttempts = attempts;
    report.maze = { width: mz.width, height: mz.height, reachable: mz.reachable.length, corridor: hc || vc, lane: lane };
    if (!(hc || vc) || !lane) throw new Error('连开 ' + attempts + ' 局都没抽到能同时做两个实验的图');

    try {
      const rngInfo = await m.eval('(() => { var st = window.__vtRng.state(); var seq = window.__vtRng.dump(); return { state: st, head: seq.slice(0, 300) }; })()');
      const stopped = await m.eval('window.__vtRng.stop()');
      report.rng = { state: rngInfo.state, stoppedLen: stopped, head300: rngInfo.head };
      P('  RNG 录制状态（复现同一张图用）: ' + JSON.stringify(rngInfo.state));
    } catch (e) { P('  RNG dump 失败: ' + e.message); }

    // 最远的可达格 → 停车位（放 tank_b / 挪走 tank_a 用）
    const corridorCenter = (c) => c.horiz
      ? { x: (c.x0 + Math.floor(c.len / 2)) * TILE + TILE / 2, y: c.y0 * TILE + TILE / 2 }
      : { x: c.x0 * TILE + TILE / 2, y: (c.y0 + Math.floor(c.len / 2)) * TILE + TILE / 2 };
    cc = corridorCenter(hc || vc);
    const ccCol = (hc || vc).horiz ? ((hc || vc).x0 + Math.floor((hc || vc).len / 2)) : (hc || vc).x0;
    const laneCol = lane ? lane.tile[0] : null;
    far = mz.reachable.reduce((best, r) => {
      // 停车位必须在【射击线之外】（不与走廊同列、不与激光跑道同列），否则会被自己的弹打死
      if (r.x === ccCol) return best;
      if (laneCol !== null && r.x === laneCol) return best;
      const d = (r.x * TILE + 5 - cc.x) ** 2 + (r.y * TILE + 5 - cc.y) ** 2;
      return d > best.d ? { r, d } : best;
    }, { r: mz.reachable.find((q) => q.x !== ccCol && q.x !== laneCol) || mz.reachable[0], d: -1 }).r;
    P(`  实验用走廊中心=(${cc.x},${cc.y})  远停车位格=(${far.x},${far.y})`);
    P(`  实验用走廊中心=(${cc.x},${cc.y})  远停车位格=(${far.x},${far.y})`);

    /* ================= 实验 ①：普通弹在走廊里反复反弹 ================= */
    const exp1 = { tag: 'bullet_corridor' };
    report.steps.push(exp1);
    try {
      await requireRound(m, '实验①前', P);
      const C = hc || vc;
      const perpRot = C.horiz ? 0 : -Math.PI / 2;   // rot=0 → 朝 -y；rot=-π/2 → 朝 -x
      const ctr = corridorCenter(C);
      await m.setControl({ fwd: false, back: false, left: false, right: false, fire: false });
      await m.teleport('tank_b', far.x * TILE + 5, far.y * TILE + 5, 0);
      await m.teleport('tank_a', ctr.x, ctr.y, perpRot);
      await m.pump(6);
      exp1.setup = { corridor: C, tankA: ctr, rot: perpRot, tankB: { x: far.x * TILE + 5, y: far.y * TILE + 5 } };

      const t0 = await m.myTank();
      P(`\n=== 实验①：普通弹贴走廊侧墙反复反弹（走廊 ${JSON.stringify(C)}）===`);
      P(`  tank_a 就位 @(${t0.x},${t0.y}) rot=${t0.rot}（rot=${perpRot.toFixed(4)}，正对侧墙）`);

      const ev0 = await m.eval('window.__vtEv.length');
      await m.eval(`window.__vtP.clear(); window.__vtP.tag = 'bullet'; window.__vtP.on = true;`);
      // 开火 1 帧
      await m.setControl({ fire: true });
      await m.pump(1);
      await m.setControl({ fire: false });
      const nAfterFire = await m.projectileCount();
      // 立刻把 tank_a 挪走（弹反弹回来会打死自己 —— 撞墙后 deadlyToOwner=true）
      await m.teleport('tank_a', far.x * TILE + 5, far.y * TILE + 5, 0);
      exp1.firedProjectiles = nAfterFire;
      P(`  开火后场上弹数=${nAfterFire}；tank_a 已挪到 (${far.x * TILE + 5},${far.y * TILE + 5})`);

      let pumped = 0;
      for (let i = 0; i < 300; i++) {
        await m.pump(3);
        pumped += 3;
        if (await m.projectileCount() === 0) break;
      }
      await m.eval('window.__vtP.on = false');
      exp1.pumpedFrames = pumped;

      const rows = await dumpRows(m);
      const hits = await m.eval('window.__vtP.hits.slice()');
      exp1.rows = rows.length; exp1.hits = hits;

      const ids = new Set();
      for (const r of rows) for (const p of r.p) if (p.ty === -1) ids.add(p.id);
      exp1.bulletIds = [...ids];
      const id = [...ids][0];
      const seq = rows.map((r) => ({ f: r.f, t: r.t, evN: r.evN, evNbMax: r.evNbMax, alive: r.alive, tk: r.tk, p: r.p.find((x) => x.id === id) || null }));

      const csv = ['f,t,exists,x,y,vx,vy,speed,timeAlive,stopped,deadly,nbounce,bounceAgesMs,contactEvents,prePruneNbMax,tanksAlive'];
      let last = null, maxNb = 0, bounceEvents = 0, prevNb = 0, prevAge = null;
      const bounceFrames = [];
      let speed0 = null;
      for (const s of seq) if (s.p && speed0 === null) speed0 = s.p.sp;
      for (const s of seq) {
        if (!s.p) { csv.push(`${s.f},${s.t},0,,,,,,,,,,,,${s.evN || 0},${s.evNbMax || 0},${s.alive}`); continue; }
        const p = s.p;
        csv.push(`${s.f},${s.t},1,${p.x},${p.y},${p.vx},${p.vy},${p.sp},${p.ta},${p.st},${p.dto ? 1 : 0},${p.nb},${(p.bs || []).join('|')},${s.evN || 0},${s.evNbMax || 0},${s.alive}`);
        if (p.nb > maxNb) maxNb = p.nb;
        if (p.nb !== prevNb) { bounceEvents++; bounceFrames.push({ f: s.f, t: s.t, nb: p.nb, ta: p.ta, ages: p.bs, y: p.y, vy: p.vy, why: 'nb' }); prevNb = p.nb; }
        const age0 = (p.bs && p.bs.length) ? p.bs[0] : null;
        if (age0 !== null && prevAge !== null && age0 > prevAge + 5) {
          bounceEvents++; bounceFrames.push({ f: s.f, t: s.t, nb: p.nb, ta: p.ta, ages: p.bs, y: p.y, vy: p.vy, why: 'ageReset' });
        }
        if (age0 !== null) prevAge = age0;
        last = Object.assign({ f: s.f, t: s.t }, p);
      }
      exp1.csv = writeCsv(path.join(PROFDIR, 'probe_bl_bullet_frames.csv'), csv);
      exp1.summary = {
        totalSamples: seq.length, aliveSamples: seq.filter((s) => s.p).length,
        maxBouncesLen: maxNb, bounceChanges: bounceEvents,
        bounceFrames: bounceFrames.slice(0, 80),
        lastAlive: last, firstSpeed: speed0,
        hits: hits.filter((h) => !h.err),
      };
      P(`  帧数=${seq.length}，弹存在帧=${exp1.summary.aliveSamples}，最大 bounces.length=${maxNb}，bounces 变更次数=${bounceEvents}`);
      P('  bounces 变化点（前 14）：');
      for (const b of bounceFrames.slice(0, 14)) P(`    f${b.f} t=${b.t}ms ta=${b.ta}s nb=${b.nb} ages=${JSON.stringify(b.ages)} vy=${b.vy}`);
      if (last) P(`  最后一帧: f${last.f} ta=${last.ta}s lifetime=${last.la} nb=${last.nb} stopped=${last.st} ages=${JSON.stringify(last.bs)} 位置=(${last.x},${last.y}) v=(${last.vx},${last.vy})`);
      const evs1 = await m.eval(`window.__vtEv.slice(${ev0}).filter(function(e){ return e.id === '${id}'; })`);
      exp1.bounceEvents = evs1;
      P(`  该弹的全部事件（${evs1.length} 条；含撞墙点/法线/解算后速度/pre-prune nb）:`);
      for (const h of evs1) P(`    f${h.f} ${h.evt} nb=${h.nb} ta=${h.ta}s point=(${h.cx},${h.cy}) normal=(${h.nx},${h.ny}) v=(${h.vx},${h.vy})`);
    } catch (e) { exp1.err = String((e && e.stack) || e); P('  X 实验①失败: ' + exp1.err); }

    /* ================= 实验 ③（附加）：炮口顶死墙发射 ================= */
    const exp3 = { tag: 'muzzle_wall' };
    report.steps.push(exp3);
    try {
      P(`\n=== 实验③：炮口顶死墙发射（tank_b，弹可能生成在墙里）===`);
      await requireRound(m, 'exp3-before', P);
      const spot = mz.reachable.find((r) => !openSet.has(key(r.x, r.y - 1)));
      if (!spot) throw new Error('找不到上方是墙的格子');
      await m.eval(`window.__vtTankId = 'tank_b'; 1`);
      await m.setControl({ fwd: false, back: false, left: false, right: false, fire: false });
      await m.teleport('tank_b', spot.x * TILE + 5, spot.y * TILE + 5, 0);
      await m.pump(6);
      await m.setControl({ fwd: true });
      let lastP = null, still = 0;
      for (let i = 0; i < 80; i++) {
        await m.pump(1);
        const t = await m.eval(`(() => { var t = GameManager.getGameController().getTank('tank_b'); return t ? { x: t.getX(), y: t.getY() } : null; })()`);
        if (!t) { lastP = 'dead'; break; }
        if (lastP && lastP !== 'dead' && Math.hypot(t.x - lastP.x, t.y - lastP.y) < 0.01) { if (++still >= 3) { lastP = t; break; } }
        else still = 0;
        lastP = t;
      }
      await m.setControl({ fwd: false });
      await m.pump(3);
      exp3.pressed = lastP;
      P(`  怼墙停点: ${JSON.stringify(lastP)}（格中心 y=${spot.y * TILE + 5}，上方墙内表面 y=${spot.y * TILE + 0.4}）`);

      await m.eval(`window.__vtP.clear(); window.__vtP.tag = 'muzzle'; window.__vtP.on = true;`);
      const ev0 = await m.eval('window.__vtEv.length');
      await m.setControl({ fire: true });
      await m.pump(1);
      await m.setControl({ fire: false });
      exp3.firedProjectiles = await m.projectileCount();
      for (let i = 0; i < 30; i++) {
        await m.pump(3);
        if (await m.projectileCount() === 0) break;
      }
      await m.eval('window.__vtP.on = false');
      const rows = await dumpRows(m);
      const hits = await m.eval(`window.__vtEv.slice(${ev0})`);
      const csv = ['f,t,nproj,x,y,vx,vy,speed,timeAlive,stopped,deadly,nbounce,bounceAgesMs'];
      let maxNb = 0;
      const detail = [];
      for (const r of rows) {
        const list = r.p.filter((p) => p.o === 'tank_b');
        if (!list.length) { csv.push(`${r.f},${r.t},0`); continue; }
        for (const p of list) {
          csv.push(`${r.f},${r.t},${list.length},${p.x},${p.y},${p.vx},${p.vy},${p.sp},${p.ta},${p.st},${p.dto ? 1 : 0},${p.nb},${(p.bs || []).join('|')}`);
          if (p.nb > maxNb) maxNb = p.nb;
          detail.push({ f: r.f, nb: p.nb, ta: p.ta, ages: p.bs, dto: p.dto });
        }
      }
      exp3.csv = writeCsv(path.join(PROFDIR, 'probe_bl_muzzle_frames.csv'), csv);
      exp3.summary = { samples: rows.length, maxBouncesLen: maxNb, detail: detail.slice(0, 120),
                       tanksPerFrame: rows.map((r) => r.alive), hits: hits };
      P(`  帧数=${rows.length}，最大 bounces.length=${maxNb}`);
      for (const d of detail.slice(0, 24)) P(`    f${d.f} ta=${d.ta}s nb=${d.nb} ages=${JSON.stringify(d.ages)}`);
      P(`  撞墙事件（共 ${hits.length}）:`);
      for (const h of hits.slice(0, 14)) P(`    ${JSON.stringify(h)}`);
    } catch (e) { exp3.err = String((e && e.stack) || e); P('  X 实验③失败: ' + exp3.err); }

    /* ================= 实验 ②：激光撞墙 ================= */
    const exp2 = { tag: 'laser' };
    report.steps.push(exp2);
    try {
      await requireRound(m, '实验②前', P);
      const C = lane;
      const start = { x: lane.tank.x, y: lane.tank.y, rot: lane.rot };
      const along = lane.dir;
      const farInner = JSON.stringify(lane.wallInner);
      const nearInner = '';

      P(`\n=== 实验②：激光撞墙（走廊 ${JSON.stringify(C)}，朝 +${along}）===`);
      const gived = await m.eval(`(() => {
        var gc = GameManager.getGameController();
        var ws = LaserWeapon.createInitialWeaponState(IdGenerator.instance.gen('lw'), 'tank_a');
        gc.roundController.setWeaponState(ws);          // 与 training_mode.js:applyEmitterWeapon 同一入口
        var w = gc.getActiveWeapon('tank_a');
        var d = gc.getDefaultWeapon('tank_a');
        return { setType: ws.getType(), activeType: w ? w.getType() : null,
                 activeFields: w ? JSON.stringify(w.getFields()) : null,
                 defaultType: d ? d.getType() : null };
      })()`);
      exp2.giveWeapon = gived;
      P('  给武器: ' + JSON.stringify(gived));

      await m.eval(`window.__vtTankId = 'tank_a'; 1`);
      await m.setControl({ fwd: false, back: false, left: false, right: false, fire: false });
      await m.teleport('tank_a', start.x, start.y, start.rot);
      await m.pump(6);
      exp2.setup = { lane: lane, tankA: start, parkTile: far };

      const t0 = await m.myTank();
      P(`  tank_a @(${t0.x},${t0.y}) rot=${t0.rot.toFixed(4)}；尽头墙内表面 ${along}=${farInner}；近端墙内表面 ${along}=${nearInner}`);

      await m.eval(`window.__vtP.clear(); window.__vtP.tag = 'laser'; window.__vtP.on = true;`);
      await m.setControl({ fire: true });
      await m.pump(1);
      await m.setControl({ fire: false });
      const nAfterFire = await m.projectileCount();
      await m.teleport('tank_a', far.x * TILE + 5, far.y * TILE + 5, 0);
      exp2.firedProjectiles = nAfterFire;
      P(`  开火后场上弹数=${nAfterFire}；tank_a 已挪走`);

      let pumped = 0;
      for (let i = 0; i < 90; i++) {           // 激光寿命 0.8s = 48 帧
        await m.pump(2);
        pumped += 2;
        if (await m.projectileCount() === 0) break;
      }
      await m.eval('window.__vtP.on = false');
      exp2.pumpedFrames = pumped;

      const rows = await dumpRows(m);
      const hits = await m.eval('window.__vtP.hits.slice()');
      exp2.rows = rows.length; exp2.hits = hits;

      const ids = new Set();
      for (const r of rows) for (const p of r.p) if (p.ty === 0) ids.add(p.id);
      exp2.laserIds = [...ids];
      const id = [...ids][0];
      const evs2 = await m.eval("window.__vtEv.filter(function(e){ return e.id === '" + id + "'; })");
      exp2.bounceEvents = evs2;
      for (const h of evs2) P(`    [ev] f${h.f} t=${h.t} kind=${h.k} evt=${h.evt} victim=${h.victim || ''} nb(pre-prune)=${h.nb} ta=${h.ta}s point=(${h.cx},${h.cy}) normal=(${h.nx},${h.ny}) v=(${h.vx},${h.vy})`);
      const seq = rows.map((r) => ({ f: r.f, t: r.t, evN: r.evN, evNbMax: r.evNbMax, alive: r.alive, tk: r.tk, p: r.p.find((x) => x.id === id) || null }));

      const csv = ['f,t,exists,x,y,vx,vy,speed,timeAlive,stopped,deadly,nbounce,bounceAgesMs,contactEvents,prePruneNbMax,tanksAlive'];
      let last = null, prevV = null;
      const flips = [];
      for (const s of seq) {
        if (!s.p) { csv.push(`${s.f},${s.t},0,,,,,,,,,,,,${s.evN || 0},${s.evNbMax || 0},${s.alive}`); continue; }
        const p = s.p;
        csv.push(`${s.f},${s.t},1,${p.x},${p.y},${p.vx},${p.vy},${p.sp},${p.ta},${p.st},${p.dto ? 1 : 0},${p.nb},${(p.bs || []).join('|')},${s.evN || 0},${s.evNbMax || 0},${s.alive}`);
        if (prevV && ((prevV.vx > 0) !== (p.vx > 0) || (prevV.vy > 0) !== (p.vy > 0))) {
          flips.push({ f: s.f, prev: prevV, now: p });
        }
        prevV = p;
        last = Object.assign({ f: s.f, t: s.t }, p);
      }
      exp2.csv = writeCsv(path.join(PROFDIR, 'probe_bl_laser_frames.csv'), csv);
      exp2.summary = {
        totalSamples: seq.length, aliveSamples: seq.filter((s) => s.p).length,
        flips: flips.map((f) => ({ f: f.f, before: { x: f.prev.x, vx: f.prev.vx, vy: f.prev.vy, sp: f.prev.sp }, after: { x: f.now.x, vx: f.now.vx, vy: f.now.vy, sp: f.now.sp } })),
        lastAlive: last,
        hits: hits.filter((h) => !h.err),
      };
      P(`  帧数=${seq.length}，弹存在帧=${exp2.summary.aliveSamples}，方向翻转 ${flips.length} 次`);
      P('  逐帧（全部）：');
      for (const s of seq) {
        if (!s.p) { P(`    f${s.f} t=${s.t}  -- 无激光弹（已消失） --`); continue; }
        const p = s.p;
        P(`    f${s.f} t=${s.t} x=${p.x} y=${p.y} v=(${p.vx},${p.vy}) |v|=${p.sp} ta=${p.ta}s nb=${p.nb} dto=${p.dto ? 1 : 0} ages=${JSON.stringify(p.bs)}`);
      }
      P(`  撞墙事件（共 ${hits.length}）:`);
      for (const h of hits) P(`    ${JSON.stringify(h)}`);
    } catch (e) { exp2.err = String((e && e.stack) || e); P('  X 实验②失败: ' + exp2.err); }

    /* ============ 实验 ④（合成，走客户端 API）：把弹直接种在墙里 ============
     * 目的：检验第三条规则的【语义】—— 它到底是不是"最近 35ms 内 ≥5 次接触"？
     * 做法：用 gc.roundController.setProjectileState(ProjectileState.withState(...))（客户端建弹的同一个入口）
     *       把一颗普通弹种在墙体内部，速度给到"几乎为 0"，让它被位置修正慢慢挤出 → 每帧都产生接触。
     *       A: 种在墙面正中（预计每帧 1 次接触）
     *       B: 种在两面墙的【内角】交点上（预计每帧 2 次接触 → 3 帧内就能凑到 6 次）
     * 这是【人造场景】，只用来确认规则能不能被触发、触发时长什么样；不当自然对局证据。
     * ================================================================= */
    for (const seedCase of ['A_face', 'B_corner']) {
      const exp4 = { tag: 'wallseed_' + seedCase };
      report.steps.push(exp4);
      try {
        await requireRound(m, '实验④' + seedCase + '前', P);
        let sx = null, sy = null, picked = null;
        if (seedCase === 'A_face') {
          const f = mz.reachable.find((r) => !openSet.has(key(r.x + 1, r.y)));
          if (!f) throw new Error('找不到 +x 方向是墙的格子');
          sx = (f.x + 1) * TILE; sy = f.y * TILE + TILE / 2;
          picked = { tile: [f.x, f.y], why: '+x 是墙 → 种子在墙面正中' };
        } else {
          const f = mz.reachable.find((r) => !openSet.has(key(r.x - 1, r.y)) && !openSet.has(key(r.x, r.y - 1)));
          if (!f) throw new Error('找不到「左侧+上方都是墙」的角落格');
          sx = f.x * TILE; sy = f.y * TILE;
          picked = { tile: [f.x, f.y], why: '左侧+上方都是墙 → 种子在两面墙的内角交点' };
        }
        const pid = 'probe_seed_' + seedCase;
        P(`\n=== 实验④(合成) ${seedCase}：把弹种在 (${sx},${sy}) — ${picked.why} ===`);
        const seeded = await m.eval(`(() => {
          var gc = GameManager.getGameController();
          var ps = ProjectileState.withState('${pid}','tank_a',Constants.WEAPON_TYPES.BULLET, ${sx}, ${sy}, 0.001, 0.001);
          gc.roundController.setProjectileState(ps);
          var p = gc.getProjectile('${pid}');
          return p ? { id: p.getId(), x: p.getX(), y: p.getY(), vx: p.getSpeedX(), vy: p.getSpeedY(),
                       tw: p.timeoutWindow, tc: p.timeoutBounceCount, la: p.lifetime, ta: p.getTimeAlive() } : null;
        })()`);
        exp4.seeded = seeded; exp4.picked = picked;
        P('  种下: ' + JSON.stringify(seeded));
        await m.eval(`window.__vtP.clear(); window.__vtP.tag = 'wallseed_${seedCase}'; window.__vtP.on = true;`);
        for (let i = 0; i < 40; i++) {
          await m.pump(1);
          const still = await m.eval(`!!GameManager.getGameController().getProjectile('${pid}')`);
          if (!still) break;
        }
        await m.eval('window.__vtP.on = false');
        const rows = await dumpRows(m);
        const evs = await m.eval("window.__vtEv.filter(function(e){return e.id === '" + pid + "';})");
        const csv = ['f,t,exists,x,y,vx,vy,speed,timeAlive,stopped,deadly,nbounce,bounceAgesMs,contactEvents,prePruneNbMax,tanksAlive'];
        const per = [];
        for (const r of rows) {
          const p = r.p.find((x) => x.id === pid);
          if (!p) { csv.push(`${r.f},${r.t},0,,,,,,,,,,,,${r.evN || 0},${r.evNbMax || 0},${r.alive}`); per.push({ f: r.f, exists: 0 }); continue; }
          csv.push(`${r.f},${r.t},1,${p.x},${p.y},${p.vx},${p.vy},${p.sp},${p.ta},${p.st},${p.dto ? 1 : 0},${p.nb},${(p.bs || []).join('|')},${r.evN || 0},${r.evNbMax || 0},${r.alive}`);
          per.push({ f: r.f, exists: 1, x: p.x, y: p.y, ta: p.ta, nb: p.nb, ages: p.bs, evN: r.evN, evNbMax: r.evNbMax, st: p.st });
        }
        exp4.csv = writeCsv(path.join(PROFDIR, `probe_bl_wallseed_${seedCase}.csv`), csv);
        exp4.summary = { samples: rows.length, perFrame: per, events: evs,
                         最大样本内nb: per.reduce((a, b) => Math.max(a, b.nb || 0), 0),
                         本帧接触数序列: per.map((x) => x.evN) };
        P('  逐帧:');
        for (const x of per) P(`    f${x.f} exists=${x.exists} ${x.exists ? `pos=(${x.x},${x.y}) ta=${x.ta}s nb=${x.nb} ages=${JSON.stringify(x.ages)} 本帧接触=${x.evN} 事件内nbMax=${x.evNbMax} stopped=${x.st}` : '(弹已消失=done() 触发)'}`);
        P(`  该弹的撞墙事件（共 ${evs.length}）:`);
        for (const e of evs.slice(0, 24)) P(`    f${e.f} nb=${e.nb} ta=${e.ta} point=(${e.cx},${e.cy}) normal=(${e.nx},${e.ny}) v=(${e.vx},${e.vy})`);
      } catch (e) { exp4.err = String((e && e.stack) || e); P('  X 实验④' + seedCase + '失败: ' + exp4.err); }
    }

    try { report.roundEvents = await m.eval('window.__vtEv.slice()'); } catch (e) { report.roundEventsErr = String(e.message || e); }
    const __evs = report.roundEvents || [];
    const __byName = {};
    for (const e of __evs) __byName[e.k + ':' + e.evt] = (__byName[e.k + ':' + e.evt] || 0) + 1;
    P('=== 事件流汇总 ===');
    P('  ' + JSON.stringify(__byName));
    const __mazeEvs = __evs.filter((e) => e.evt === 'projectile maze collision' || e.evt === 'projectile shield collision');
    const __g = {};
    for (const e of __mazeEvs) { (__g[e.id] = __g[e.id] || []).push(e); }
    P('  撞墙/撞盾事件按弹分组：');
    for (const k in __g) {
      const list = __g[k];
      const gaps = [];
      for (let i = 1; i < list.length; i++) gaps.push(list[i].f - list[i - 1].f);
      P(`    ${k} (ty=${list[0].ty}): n=${list.length} frames=[${list.slice(0, 26).map((x) => x.f).join(',')}] 帧间隔=[${gaps.slice(0, 26).join(',')}]`);
    }
    P('  非撞墙事件明细：');
    for (const e of __evs) { if (e.evt === 'projectile maze collision' || e.evt === 'projectile shield collision') continue; P('    ' + JSON.stringify(e)); }
    report.vtStats = await m.stats();
    P('\n=== 页面错误/vtStats ===\n  ' + JSON.stringify(report.vtStats));
    P('  pageErrors: ' + JSON.stringify(m.pageErrors.slice(0, 5)));
  } catch (e) {
    report.fatal = String((e && e.stack) || e);
    console.error('FATAL:', report.fatal);
    process.exitCode = 1;
  } finally {
    try { fs.writeFileSync(path.join(PROFDIR, 'probe_bl_report.json'), JSON.stringify(report, null, 1)); } catch (e) {}
    try { await m.close(); } catch (e) {}
    console.log(`\n[done] 用时 ${((Date.now() - T0) / 1000).toFixed(1)}s`);
  }
})();
