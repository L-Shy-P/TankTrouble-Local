#!/usr/bin/env node
'use strict';
/* ============================================================================
 * 阶段 2-3 · A-1【单位实测探针】—— **必须第一件做**
 *
 * 为什么必须实测：`p.getX()` 是 **px** 还是 **m**，光看常量表定不了
 *   · `MAZE_TILE_SIZE.m = 10`  × 16 格 = 160
 *   · `MAZE_TILE_SIZE.px = 200` × 16 格 = 3200 ；`PIXELS_PER_METER = 20` ⟹ 3200/20 = 160
 *   ⟹ **两组数给出同一个物理尺寸** ⟹ 看数字/看名字都会骗人
 *   （`AGENTS.md` 血泪纪律④：对拍脚本【自己的输入】要先验单位）
 *
 * ⚠️ 本探针第一版的教训（**保留记档**）：先拿 `maze.getTileBounds()` 当"世界包围盒"，
 *    实测它返回的是 **【格号】**（8x5 的图 → minX0 minY0 maxX7 maxY4），不是世界坐标
 *    ⟹ 判据 1 直接 FAIL（ratio 0.0875）。**这就是"探针自己的输入要验单位"那条纪律本身。**
 *
 * 本版三条**互相独立**的证据：
 *   ① 墙的**格点阵**：从游戏自己的 b2d 世界量墙体的 x/y 坐标，去重后的**最小间隔**
 *      应等于一个格子的世界尺寸 ⟹ 比 `MAZE_TILE_SIZE.m`(10) 还是 `.px`(200)
 *   ② 坦克位姿：必须落在 `[0, w×格]` 范围里（两条假设给的范围差 20 倍）
 *   ③ **子弹每帧位移 ÷ 游戏自己的时钟(`timeAlive` 差分)** == 上报的 `|speed|`
 *      —— 分母用 `getTimeAlive()`（游戏自己的秒），**不用 FRAME_DT**，与①②不同源
 *
 * 用法：node _tools/headless/_probe_2_3_units_v2.js
 * 退出码：0=PASS，1=FAIL。
 * ============================================================================ */
const { Match } = require('./match');

const FACTS = `
(() => {
  var gc = GameManager.getGameController();
  var mz = gc.getMaze();
  var out = { ok: true };
  var C = (typeof Constants !== 'undefined') ? Constants : null;
  function J(x) { try { return JSON.parse(JSON.stringify(x)); } catch (e) { return String(x); } }
  out.hasConstants = !!C;
  out.MAZE_TILE_SIZE = C && C.MAZE_TILE_SIZE ? J(C.MAZE_TILE_SIZE) : null;
  out.MAZE_WALL_WIDTH = C && C.MAZE_WALL_WIDTH ? J(C.MAZE_WALL_WIDTH) : null;
  out.PIXELS_PER_METER = (C && typeof C.PIXELS_PER_METER === 'number') ? C.PIXELS_PER_METER : null;
  out.MAZE_MAX = (C && C.MAZE) ? J(C.MAZE) : null;
  out.LASER_SPEED = (C && C.LASER && C.LASER.SPEED !== undefined) ? J(C.LASER.SPEED) : null;
  out.BULLET_SPEED = (C && C.BULLET_SPEED !== undefined) ? C.BULLET_SPEED : null;
  out.FRAME_DT_const = (C && C.FRAME_DT !== undefined) ? C.FRAME_DT : null;
  out.sandboxFrameDt = (typeof VantageSandbox !== 'undefined' && VantageSandbox.getFrameDtSec)
    ? VantageSandbox.getFrameDtSec() : null;
  out.treeFrameDt = (typeof VantageTree !== 'undefined') ? VantageTree.FRAME_DT : null;

  out.maze = { w: mz.getWidth(), h: mz.getHeight() };
  var tb = null; try { tb = mz.getTileBounds(); } catch (e) { tb = null; }
  out.tileBounds_AS_RETURNED = tb ? J(tb) : null;   // 实测 = 格号，不是世界坐标

  // ★ 判据①：从【游戏自己的 b2d 世界】直接量**所有夹具顶点的世界包围盒**
  //   （顶点用 body.GetWorldPoint 变换 ⟹ 拿到的是真·世界坐标，不是格号）
  out.worldExtent = (function () {
    try {
      var world = gc.getB2DWorld();
      var mnx = 1e18, mny = 1e18, mxx = -1e18, mxy = -1e18, nBody = 0, nFix = 0, nVert = 0;
      var tankBox = null;
      for (var b = world.GetBodyList(); b; b = b.GetNext()) {
        nBody++;
        for (var f = b.GetFixtureList(); f !== null; f = f.GetNext()) {
          nFix++;
          var sh = f.GetShape(); if (!sh || !sh.m_vertexCount) continue;
          for (var i = 0; i < sh.m_vertexCount; i++) {
            var v = sh.m_vertices[i];
            var w = b.GetWorldPoint ? b.GetWorldPoint(v) : v;
            nVert++;
            if (w.x < mnx) mnx = w.x; if (w.x > mxx) mxx = w.x;
            if (w.y < mny) mny = w.y; if (w.y > mxy) mxy = w.y;
          }
        }
      }
      // 坦克自己的 AABB（用来判"一个坦克占几格"：10 米格 ⟹ 坦克应是几米级）
      try {
        var t0 = gc.getTank('tank_a');
        if (t0) { var tb0 = t0.getB2DBody(); var tmnx = 1e18, tmny = 1e18, tmxx = -1e18, tmxy = -1e18;
          for (var f2 = tb0.GetFixtureList(); f2 !== null; f2 = f2.GetNext()) {
            var s2 = f2.GetShape(); if (!s2 || !s2.m_vertexCount) continue;
            for (var k = 0; k < s2.m_vertexCount; k++) { var w2 = tb0.GetWorldPoint(s2.m_vertices[k]);
              if (w2.x < tmnx) tmnx = w2.x; if (w2.x > tmxx) tmxx = w2.x;
              if (w2.y < tmny) tmny = w2.y; if (w2.y > tmxy) tmxy = w2.y; } }
          tankBox = { w: +(tmxx - tmnx).toFixed(4), h: +(tmxy - tmny).toFixed(4) };
        }
      } catch (eTK) {}
      return { nBody: nBody, nFix: nFix, nVert: nVert,
               minX: +mnx.toFixed(4), maxX: +mxx.toFixed(4), minY: +mny.toFixed(4), maxY: +mxy.toFixed(4),
               extentW: +(mxx - mnx).toFixed(4), extentH: +(mxy - mny).toFixed(4), tankBox: tankBox };
    } catch (e) { return { err: String((e && e.message) || e).slice(0, 140) }; }
  })();

  out.tile_m  = (C && C.MAZE_TILE_SIZE && typeof C.MAZE_TILE_SIZE.m  === 'number') ? C.MAZE_TILE_SIZE.m  : null;
  out.tile_px = (C && C.MAZE_TILE_SIZE && typeof C.MAZE_TILE_SIZE.px === 'number') ? C.MAZE_TILE_SIZE.px : null;

  var t = gc.getTank('tank_a');
  if (t) {
    out.tank = { x: +(+t.getX()).toFixed(4), y: +(+t.getY()).toFixed(4), rot: +(+t.getRotation()).toFixed(6) };
    try { var bd = t.getB2DBody(); if (bd) { var p = bd.GetPosition();
      out.tankBody = { x: +(+p.x).toFixed(4), y: +(+p.y).toFixed(4), ang: +(+bd.GetAngle()).toFixed(6) }; } } catch (e) {}
  }
  return out;
})()`;

const PROJ = `
(() => {
  var gc = GameManager.getGameController();
  var out = [];
  var ps = gc.getProjectiles() || {};
  for (var id in ps) { var p = ps[id];
    out.push({ id: id, x: p.getX(), y: p.getY(), sx: p.getSpeedX(), sy: p.getSpeedY(),
               sp: Math.sqrt(p.getSpeedX()*p.getSpeedX() + p.getSpeedY()*p.getSpeedY()),
               type: p.getType(), life: p.lifetime, tAlive: p.getTimeAlive(),
               bodyX: (function(){ try { var b = p.getB2DBody(); return b ? b.GetPosition().x : null; } catch(e){ return null; } })(),
               bodyY: (function(){ try { var b = p.getB2DBody(); return b ? b.GetPosition().y : null; } catch(e){ return null; } })() });
  }
  return out;
})()`;

const FIRE = `
(() => {
  var gc = GameManager.getGameController(); var rc = gc.roundController;
  rc.pullTrigger('tank_a');
  rc.setInputState(InputState.withState('tank_a', false, false, false, false, false));
  return Object.keys(gc.getProjectiles() || {}).length;
})()`;

(async () => {
  const m = new Match();
  let pass = 0, fail = 0; const fails = [];
  function check(name, ok, detail) {
    if (ok) pass++; else { fail++; fails.push(name); }
    console.log((ok ? 'PASS  ' : 'FAIL  ') + name.padEnd(48) + (detail === undefined ? '' : '  ' + String(detail).slice(0, 260)));
  }
  try {
    await m.open({ humanIds: ['tank_a', 'tank_b'], aiCount: 0, vantCount: 0, control: false, rng: 'record' });
    const F = await m.eval(FACTS);
    console.log('=== A-1 单位事实（游戏 raw）===');
    console.log(JSON.stringify(F, null, 1));

    const tileM = F.tile_m, tilePx = F.tile_px;
    const W = F.worldExtent || {};
    const spanX = (tileM !== null) ? F.maze.w * tileM : null;
    const spanX_px = (tilePx !== null) ? F.maze.w * tilePx : null;
    const near = (a, b, tol) => (typeof a === 'number' && typeof b === 'number' && b !== 0 && Math.abs(a / b - 1) <= tol);
    // 容许 ±1 格（外边界墙可能有厚度/贴边）
    const isM  = near(W.extentW, spanX, 0.15);
    const isPx = near(W.extentW, spanX_px, 0.15);
    const UNIT = isM ? 'm' : (isPx ? 'px' : 'INDETERMINATE');

    console.log('=== 判据① 世界包围盒（所有夹具顶点经 body.GetWorldPoint 变换）===');
    console.log('  ' + JSON.stringify(W));
    console.log('  地图 ' + F.maze.w + 'x' + F.maze.h + ' 格 | tile.m=' + tileM + ' tile.px=' + tilePx);
    console.log('  若米: 期望世界 ' + spanX + ' x ' + (F.maze.h * tileM) + ' | 若px: 期望 ' + spanX_px + ' x ' + (F.maze.h * tilePx));
    console.log('*** 判据① 实测单位 = ' + UNIT + ' ***');
    check('世界宽 ~= w x MAZE_TILE_SIZE.m (' + spanX + ')  ==> 单位=米', isM,
      'extentW=' + W.extentW + ' ratio=' + (W.extentW && spanX ? (W.extentW / spanX).toFixed(6) : null));
    check('世界宽 != w x MAZE_TILE_SIZE.px (' + spanX_px + ') ==> px 假设被排除', !isPx,
      'extentW=' + W.extentW + ' ratio=' + (W.extentW && spanX_px ? (W.extentW / spanX_px).toFixed(6) : null));
    check('单位判定收敛（非 INDETERMINATE）', UNIT !== 'INDETERMINATE', 'UNIT=' + UNIT);
    check('坦克 AABB 是"几米级"而不是"几百单位级"（pk 判据）',
      !!(W.tankBox && W.tankBox.w > 0 && W.tankBox.w < tileM),
      'tankBox=' + JSON.stringify(W.tankBox) + ' tile=' + tileM);

    console.log('=== 判据② 坦克位姿落在地图内 ===');
    const inM = F.tank && spanX !== null && F.tank.x >= -1 && F.tank.x <= spanX + 1 && F.tank.y >= -1 && F.tank.y <= (F.maze.h * tileM) + 1;
    check('tank.x/y 落在 [0, w x tile.m] ==> 米', inM, 'span=' + spanX + 'x' + (F.maze.h * tileM) + ' tank=' + JSON.stringify(F.tank));
    check('tank.getX/Y 与 b2d body 完全一致（同一坐标系）',
      !!F.tank && !!F.tankBody && Math.abs(F.tank.x - F.tankBody.x) < 1e-9 && Math.abs(F.tank.y - F.tankBody.y) < 1e-9,
      JSON.stringify(F.tank) + ' body=' + JSON.stringify(F.tankBody));

    console.log('=== 判据③ 子弹：每帧位移 / 游戏时钟(timeAlive 差分) == 上报 |speed| ===');
    await m.eval(FIRE);
    await m.pump(2);
    const seq = [];
    for (let i = 0; i < 12; i++) { seq.push(await m.eval(PROJ)); await m.pump(1); }
    seq.push(await m.eval(PROJ));
    const id0 = (seq[0] || []).length ? seq[0][0].id : null;
    const per = [];
    for (let i = 0; i + 1 < seq.length; i++) {
      const a = (seq[i] || []).find(p => p.id === id0), b = (seq[i + 1] || []).find(p => p.id === id0);
      if (!a || !b) { per.push({ i: i, gone: true }); continue; }
      const dt = b.tAlive - a.tAlive, dist = Math.hypot(b.x - a.x, b.y - a.y);
      per.push({ i: i, dt: +dt.toFixed(6), dist: +dist.toFixed(6),
                 vFromDisp: dt > 1e-9 ? +(dist / dt).toFixed(4) : null,
                 spReported: +a.sp.toFixed(4),
                 ratio: (dt > 1e-9 && a.sp > 1e-9) ? +((dist / dt) / a.sp).toFixed(4) : null,
                 dxy: [+(b.x - a.x).toFixed(4), +(b.y - a.y).toFixed(4)] });
    }
    console.log(JSON.stringify(per, null, 1));
    const good = per.filter(r => !r.gone && r.ratio !== null);
    check('子弹：position 与 b2d body 同坐标系', (seq[0] || []).length > 0 && seq[0][0].bodyX !== null &&
      Math.abs(seq[0][0].bodyX - seq[0][0].x) < 1e-9, JSON.stringify(seq[0][0] || {}));
    check('子弹：单帧 dt>0（游戏时钟在走）', good.length > 0 && good.every(r => r.dt > 0),
      'dt=' + good.map(r => r.dt).join(','));
    check('子弹：单帧位移/dt == 上报|speed|（同单位，误差<5%）', good.length > 0 &&
      good.every(r => Math.abs(r.ratio - 1) < 0.05), 'ratios=' + good.map(r => r.ratio).join(','));
    const dts = good.map(r => r.dt);
    const medDt = dts.length ? dts.slice().sort((a, b) => a - b)[Math.floor(dts.length / 2)] : null;
    check('单帧实测 dt 落在 [0.010,0.035]（与 sandboxFrameDt 同量级）',
      medDt !== null && medDt >= 0.010 && medDt <= 0.035, 'median dt=' + medDt + ' sandboxFrameDt=' + F.sandboxFrameDt);

    console.log('SUMMARY ' + JSON.stringify({ pass: pass, fail: fail, fails: fails, UNIT: UNIT, gapX: null, tileM: tileM, tilePx: tilePx,
      worldExtent: W, medianDt: medDt, sandboxFrameDt: F.sandboxFrameDt, ratios: good.map(r => r.ratio) }));
  } catch (e) {
    console.error('PROBE FATAL ' + ((e && e.stack) || e));
    process.exitCode = 2;
  } finally {
    try { await m.close(); } catch (e) {}
  }
  if (fail) process.exitCode = 1;
})();
