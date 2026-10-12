'use strict';
/* 探针：核 `match.js` 紧凑快照里 `projs[].rot` 是不是恒为 NaN（2026-10-12 清理轮）
 *
 * 目的（只读产品代码，不改任何既有文件）：
 *   ① 从真实 roundState 里读 projectileStates[0] 的【原始键】——看有没有 `rotation`
 *   ② 复算 match.js 那行的算法 `+(+p.rotation).toFixed(4)` ——看是不是 NaN
 *   ③ 打印快照里 projectiles[0] 的字段
 *   ④ 给出 atan2 候选值与"从逐帧位移反推的朝向"对照（判 atan2 该用哪套约定）
 *
 * 用法：node _tools/headless/_rot_probe.js
 */
const { Match } = require('./match');

(async () => {
  const m = new Match();
  const out = { steps: [] };
  try {
    await m.open({ humanIds: ['tank_a', 'tank_b'], aiCount: 0, vantCount: 0 });
    out.tankId = m.tankId;

    // 开火：按下 fire，逐帧等弹出现（弹道随机性 ⟹ 不保证第 N 帧还在场）
    await m.setControl({ fire: true });
    let n = 0;
    for (let i = 0; i < 60; i++) {
      await m.pump(1, { yieldMs: 0 });
      n = await m.projectileCount();
      if (n > 0) break;
    }
    out.foundAfterFrames = n;
    await m.setControl({ fire: false });
    await m.pump(1, { yieldMs: 0 });

    const raw = await m.eval(`(() => {
      var gc = GameManager.getGameController();
      var d = __vtData(gc.getRoundState()) || {};
      var ps = d.projectileStates || [];
      var p = ps[0];
      return {
        n: ps.length,
        keys: p ? Object.keys(p).sort() : null,
        hasRotation: p ? Object.prototype.hasOwnProperty.call(p, 'rotation') : null,
        rotationRaw: p ? String(p.rotation) : null,
        p: p ? { id: p.id, playerId: p.playerId, type: p.type, x: +p.x, y: +p.y,
                 speedX: +p.speedX, speedY: +p.speedY } : null,
        tankKeys: (d.tankStates && d.tankStates[0]) ? Object.keys(d.tankStates[0]).sort() : null
      };
    })()`);
    out.raw = raw;

    const snap = await m.snapshot();
    const sp = snap.projectiles[0] || null;
    out.snapshotProj = sp;
    out.snapshotProjKeys = sp ? Object.keys(sp) : null;
    out.snapshotJSON = sp ? JSON.stringify(sp) : null;

    // 复算 applyRolloutScore… 不，是 match.js:116 那行
    if (raw.p) {
      const rotOld = +(+NaN).toFixed(4);                       // p.rotation === undefined → +undefined = NaN
      out.recompute = {
        expr: '+(+(p.rotation)).toFixed(4)',
        p_rotation: raw.hasRotation ? raw.rotationRaw : '(键不存在 → undefined)',
        result_isNaN: Number.isNaN(rotOld),
        result: String(rotOld),
        snapshot_rot_isNaN: sp ? Number.isNaN(sp.rot) : null,
        // 两个候选（速度在 vault 坐标系里）
        atan2_speedY_speedX: +Math.atan2(raw.p.speedY, raw.p.speedX).toFixed(6),
        atan2_speedX_negSpeedY: +Math.atan2(raw.p.speedX, -raw.p.speedY).toFixed(6)
      };
    }

    // 逐帧位移反推朝向（对照约定）—— 再泵 10 帧，看弹飞去哪
    const track = [];
    for (let i = 0; i < 10; i++) {
      await m.pump(1, { yieldMs: 0 });
      const r = await m.eval(`(() => {
        var gc = GameManager.getGameController();
        var d = __vtData(gc.getRoundState()) || {};
        var p = (d.projectileStates || [])[0];
        return p ? { x: +p.x, y: +p.y, sx: +p.speedX, sy: +p.speedY } : null;
      })()`);
      if (r) track.push(r);
    }
    out.track = track;
    if (track.length >= 2 && raw.p) {
      const dx = track[track.length - 1].x - track[0].x;
      const dy = track[track.length - 1].y - track[0].y;
      out.motion = {
        dx: +dx.toFixed(4), dy: +dy.toFixed(4),
        atan2_dy_dx: +Math.atan2(dy, dx).toFixed(6),
        tankRot_convention_atan2_dx_negdy: +Math.atan2(dx, -dy).toFixed(6)
      };
    }
    out.ok = !out.err;
  } catch (e) {
    out.err = String((e && e.stack) || e);
    try { out.pageErrors = m.pageErrors.slice(0, 5); } catch (e2) {}
    try { out.consoleTail = m.console.slice(-15); } catch (e3) {}
    try { out.bootstrap = m.bootstrap; } catch (e4) {}
    try { out.gcState = await m.eval('(()=>{var gc=GameManager.getGameController(); return gc?gc.getState():null})()'); } catch (e5) {}
  } finally {
    try { await m.close(); } catch (e) {}
  }
  console.log(JSON.stringify(out, null, 2));
  if (out.err) process.exitCode = 1;
})();
