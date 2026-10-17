#!/usr/bin/env node
'use strict';
/* ============================================================================
 * S1（权威版 §12.3）子弹「非正常消失」移除链 —— 自证探针
 *
 * 证明四件事（全部用**真实对局**，不是假对象）：
 *   ① 【真的生效】子弹因"有人非正常退出"被移除 ⟹ 融合世界的**槽真的空了**、
 *      且**被它判死的帧真的放活了**（dead:true → false），给数字。
 *   ② 【假阳率】"弹没了"这件事在**正常超时/正常撞掉**时会不会被误判成"移除"？给分母。
 *   ③ 【单调性】移除**只会让帧从死变活 / 死得更晚**，绝不 活→死、绝不 死得更早。
 *   ④ 【负例】移除一颗**不是凶手**的弹 ⟹ 生死一个字节都不动。
 *
 * 只读产品代码；只写 `_tools/headless/_s1_prof/`。
 * 用法：node _tools/headless/_s1_removal_probe.js
 * ============================================================================ */
const fs = require('fs');
const path = require('path');
const { Match } = require('./match');

const OUT = path.join(__dirname, '_s1_prof');
const DT = 0.02;
const GRAZE = 2.80;          // 弹走的横向线：车头正前方 2.80 m（只够到"塔尖 2.7 + 半径 0.25"）
const HOLD = [{ name: 'hold', inputs: { forward: false, back: false, left: false, right: false } }];

const INSTALL = `(() => {
  window.__s1 = {
    gc: function () { return GameManager.getGameController(); },
    /* 找一个"车头正前方够开阔"的格心（rot=0，车头朝 -y） */
    findPose: function (graze) {
      var gc = GameManager.getGameController(), maze = gc.getMaze(), world = gc.getB2DWorld();
      var TILE = Constants.MAZE_TILE_SIZE.m, out = null;
      if (!maze || !world) return { err: 'no maze/world' };
      for (var i = 1; i < maze.width - 1 && !out; i++) {
        for (var j = 2; j < maze.height - 1 && !out; j++) {
          var x = i * TILE + TILE / 2, y = j * TILE + TILE / 2;
          var bx = x, by = y - graze;
          var cA = false, cB = false;
          try {
            cA = B2DUtils.checkLineForMazeCollision(world,
              Box2D.Common.Math.b2Vec2.Make(x, y - 1.2), Box2D.Common.Math.b2Vec2.Make(bx, by - 0.4)) !== true;
            cB = B2DUtils.checkLineForMazeCollision(world,
              Box2D.Common.Math.b2Vec2.Make(bx, by - 0.4), Box2D.Common.Math.b2Vec2.Make(bx, by + 0.4)) !== true;
          } catch (e) { cA = false; cB = false; }
          if (cA && cB) out = { x: x, y: y, rot: 0, bx: bx, by: by };
        }
      }
      return out || { err: 'no clear pose' };
    },
    spawnBullet: function (x, y, vx, vy, owner, type) {
      var rc = GameManager.getGameController().roundController;
      var id = IdGenerator.instance.gen('s1b');
      rc.setProjectileState(ProjectileState.withState(id, owner, type, x, y, vx, vy));
      return id;
    },
    projIds: function () {
      var gc = GameManager.getGameController(), d = __vtData(gc.getRoundState()) || {};
      return (d.projectileStates || []).map(function (p) { return p.id; });
    },
    /* 用**真实游戏入口**触发"有人非正常退出"：RoundModel.removeTank ⟹ 他的弹全被删（无 PROJECTILE_* 事件） */
    chickenOut: function (pid) {
      var gc = GameManager.getGameController();
      try { gc.roundController.removeTank(pid); } catch (e) { return { err: String((e && e.message) || e) }; }
      return { ok: true };
    },
    /* 直接踢游戏自己的销毁入口（= 正常撞掉路径；会派发 PROJECTILE_DESTROYED） */
    killProjectile: function (id) {
      var gc = GameManager.getGameController();
      try { gc.roundController.destroyProjectile(id); } catch (e) { return { err: String((e && e.message) || e) }; }
      return { ok: true };
    },
    lifetimeOf: function () { return Constants.BULLET_MAX_LIFETIME; },
    projInfo: function (id) {
      var gc = GameManager.getGameController();
      var p = gc.getProjectile ? gc.getProjectile(id) : null;
      if (!p) return null;
      return { id: id, type: p.getType ? p.getType() : null, owner: p.getPlayerId ? p.getPlayerId() : null,
               age: p.getTimeAlive ? p.getTimeAlive() : null,
               life: (p.lifetime === undefined ? null : p.lifetime) };
    }
  };
  return { ok: true };
})()`;

async function shot(m, adapter, pose, ops, frames) {
  // 跑一轮融合批次（**不重跑树**）：候选在 pose，真实弹按真实位姿摆进去
  return m.eval(`(() => {
    var gc = GameManager.getGameController();
    var ad = VantageSandbox.createAdapter(gc, 'tank_a');
    var ops = ${JSON.stringify(ops)};
    var pose = { x: ${pose.x}, y: ${pose.y}, rot: 0 };
    var r = ad.simulateTankBatchJsFused(pose, ops, ${frames}, {
      startPose: pose, threats: [], tGlobal: 0, nowTGlobal: 0, auditPurpose: 'scanNodeDeath'
    });
    return {
      results: r.map(function (x) { return { dead: !!x.dead, deathFrame: x.deathFrame }; }),
      causes: ad.getLastDeathCauses(),
      causeSeq: ad.getLastDeathCauseSeq(),
      placements: ((ad.getLastFusedBatchSummary() || {}).placements || []).map(function (p) {
        return { pid: p.pid, active: p.active, src: p.src, x: p.x, y: p.y, vx: p.vx, vy: p.vy }; }),
      slots: ad.getFusedBulletSlots(),
      batchRemoval: (ad.getLastFusedBatchSummary() || {}).removal || null,
      removedSoFar: ad.getRemovedProjectiles(),
      stats: ad.getRemovalStats()
    };
  })()`);
}

(async () => {
  const res = { startedAt: new Date().toISOString(), steps: [], errors: [] };
  const m = new Match();
  try {
    // ⚠️ 3 辆车：后面要"踢掉 tank_b"，2 辆时回合会直接结束（换局会清账本）
    await m.open({ humanIds: ['tank_a', 'tank_b', 'tank_c'], aiCount: 0, vantCount: 0 });
    await m.clearControl();
    await m.eval(INSTALL);
    const pose = await m.eval(`window.__s1.findPose(${GRAZE})`);
    res.pose = pose;
    if (pose.err) throw new Error('findPose: ' + pose.err);
    res.bulletLifetime = await m.eval('window.__s1.lifetimeOf()');
    res.lifetimeFrames = Math.ceil((res.bulletLifetime || 10) / DT);
    for (const t of [['tank_a', 5, 5], ['tank_b', 65, 45], ['tank_c', 5, 45]]) {
      await m.teleport(t[0], t[1], t[2], 0).catch(() => { });
    }
    const scan = () => m.eval(`(() => { var gc = GameManager.getGameController();
      return VantageSandbox.createAdapter(gc, 'tank_a').scanProjectileRemovals(); })()`);
    const addStep = (name, obj) => { const st = Object.assign({ name: name }, obj); res.steps.push(st);
      console.log(name + ' ' + JSON.stringify(st)); return st; };

    /* ================= 假阳率（2 个正常消失用例） ================= */
    // FP-1 正常"撞掉"：走游戏自己的 destroyProjectile ⟹ PROJECTILE_DESTROYED
    const dId = await m.eval(`window.__s1.spawnBullet(${pose.x - 0.4}, ${pose.y - GRAZE}, 1.0, 0, 'tank_a', ${-1})`);
    await m.pump(2, { yieldMs: 0 });
    await scan();                                   // ★ 注册（账本"见过"它）
    await m.eval(`window.__s1.killProjectile(${JSON.stringify(dId)})`);
    await m.pump(3, { yieldMs: 0 });
    const sD = await scan();
    addStep('FP1_normal_destroyed', { bulletId: dId, vanished: sD.vanished, abnormal: sD.abnormal,
      normalHit: sD.normalHit, normalTimeout: sD.normalTimeout, heuristicNormal: sD.heuristicNormal });

    // FP-2 正常"寿命到期"：什么都不做，等它自己到点
    const eId = await m.eval(`window.__s1.spawnBullet(${pose.x - 0.4}, ${pose.y - GRAZE}, 0.002, 0, 'tank_a', ${-1})`);
    await m.pump(2, { yieldMs: 0 });
    await scan();                                   // 注册
    let eGone = false, eInfo = null, pumped = 0;
    for (let round = 0; round < 6 && !eGone; round++) {
      await m.pump(120, { yieldMs: 0 }); pumped += 120;
      eGone = (await m.eval('window.__s1.projIds()')).indexOf(eId) < 0;
      if (!eGone) eInfo = await m.eval(`window.__s1.projInfo(${JSON.stringify(eId)})`);
    }
    const sE = await scan();
    addStep('FP2_normal_timeout', { bulletId: eId, bulletGone: eGone, pumpedFrames: pumped,
      lastInfo: eInfo, vanished: sE.vanished, abnormal: sE.abnormal, normalTimeout: sE.normalTimeout,
      normalHit: sE.normalHit, heuristicNormal: sE.heuristicNormal });

    /* ================= A. 基线：真弹把候选 op0 判死 ================= */
    const bId = await m.eval(`window.__s1.spawnBullet(${pose.x - 0.4}, ${pose.y - GRAZE}, 1.0, 0, 'tank_b', ${-1})`);
    await m.pump(2, { yieldMs: 0 });
    const A = await shot(m, null, pose, HOLD, 75);
    addStep('A_baseline_dead', { bulletId: bId, dead: A.results[0].dead, deathFrame: A.results[0].deathFrame,
      causes: A.causes && A.causes[0] ? A.causes[0].causes : null,
      causeSeq: A.causeSeq, slotsInRound: A.slots.slots.filter(s => s.inThisRound).map(s => s.pid) });

    /* ================= B. 非正常消失：owner 退出 ================= */
    const beforeIds = await m.eval('window.__s1.projIds()');
    await m.eval(`window.__s1.chickenOut('tank_b')`);
    await m.pump(3, { yieldMs: 0 });
    const afterIds = await m.eval('window.__s1.projIds()');
    const B = await shot(m, null, pose, HOLD, 75);
    const slotRow = B.slots.slots.filter(s => String(s.pid) === String(bId))[0] || null;
    addStep('B_abnormal_removed', {
      bulletGone: beforeIds.indexOf(bId) >= 0 && afterIds.indexOf(bId) < 0,
      batchRemoval: B.batchRemoval, removedSoFar: B.removedSoFar,
      slot: slotRow ? { pid: slotRow.pid, inThisRound: slotRow.inThisRound, active: slotRow.active,
                        bodyActive: slotRow.bodyActive, retired: slotRow.retired, hasProjObj: slotRow.hasProjObj } : null,
      deadInThatBatch: B.results[0].dead, fdInThatBatch: B.results[0].deathFrame });

    /* ================= C. ③ 单调放活（显式传 A 批次的死因表） ================= */
    const C = await m.eval(`(() => {
      var gc = GameManager.getGameController();
      var ad = VantageSandbox.createAdapter(gc, 'tank_a');
      return ad.releaseDeathsAfterRemoval(${JSON.stringify(A.results)}, ${JSON.stringify([bId])}, ${JSON.stringify(A.causes)});
    })()`);
    addStep('C_release_monotone', { released: C.released, moved: C.moved, kept: C.kept,
      unattributed: C.unattributed, monotoneOk: C.monotoneOk, usedOwnCauses: C.usedOwnCauses,
      before: A.results[0], after: C.results[0] });

    /* ================= F/G/H/I. 两个凶手：单调 + 负例 ================= */
    const f1 = await m.eval(`window.__s1.spawnBullet(${pose.x - 0.4}, ${pose.y - GRAZE}, 1.0, 0, 'tank_a', ${-1})`);   // 早到
    // 晚到的那颗：沿 findPose **验证过的纵向走廊** (x, y-1.2)…(x, y-3.6) 朝车走 ⟹ ~0.65 s ≈ 39 帧后接触
    const f2 = await m.eval(`window.__s1.spawnBullet(${pose.x}, ${pose.y - 3.6}, 0, 1.0, "tank_a", ${-1})`);
    const f3 = await m.eval(`window.__s1.spawnBullet(${pose.x - 20.0}, ${pose.y - 14.0}, 0.002, 0, 'tank_a', ${-1})`); // 无关
    await m.pump(2, { yieldMs: 0 });
    const F = await shot(m, null, pose, HOLD, 400);
    const rel = (ids) => m.eval(`(() => {
      var gc = GameManager.getGameController();
      var ad = VantageSandbox.createAdapter(gc, 'tank_a');
      return ad.releaseDeathsAfterRemoval(${JSON.stringify(F.results)}, ${JSON.stringify(ids)}, ${JSON.stringify(F.causes)});
    })()`);
    const G = await rel([f1]);            // 移除"早的那颗" ⟹ 死得更晚
    const H = await rel([f3]);            // 移除"无关的那颗" ⟹ 一个字节不动
    const I2 = await rel([f1, f2]);       // 两颗凶手都移除 ⟹ 放活
    const fDiag = await m.eval(`(() => { var gc = GameManager.getGameController();
      return { f2info: (function(){ var p = gc.getProjectile(${JSON.stringify(f2)});
                 return p ? { age: p.getTimeAlive ? p.getTimeAlive() : null, life: p.lifetime,
                              vx: p.getSpeedX ? p.getSpeedX() : null, vy: p.getSpeedY ? p.getSpeedY() : null } : null; })() }; })()`);
    addStep('F_two_killers', { early: f1, late: f2, unrelated: f3, dead: F.results[0].dead,
      fd: F.results[0].deathFrame, causes: F.causes && F.causes[0] ? F.causes[0].causes : null,
      slotsInRound: F.slots.slots.filter(s => s.inThisRound).map(s => s.pid),
      batchPlacements: ((F.placements || {}) || []) , f2info: fDiag.f2info });
    addStep('G_remove_early_monotone', { before: F.results[0], after: G.results[0], moved: G.moved,
      kept: G.kept, released: G.released, monotoneOk: G.monotoneOk });
    addStep('H_remove_unrelated_noop', { before: F.results[0], after: H.results[0], moved: H.moved,
      kept: H.kept, released: H.released, monotoneOk: H.monotoneOk });
    addStep('I_remove_both_released', { before: F.results[0], after: I2.results[0],
      released: I2.released, monotoneOk: I2.monotoneOk });
    /* ================= J. 全轮累计账（假阳率口径） ================= */
    res.cumulative = await m.eval(`(() => { var gc = GameManager.getGameController();
      var ad = VantageSandbox.createAdapter(gc, 'tank_a');
      return { stats: ad.getRemovalStats(), removed: ad.getRemovedProjectiles() }; })()`);
    addStep('J_cumulative', res.cumulative.stats);
  } catch (e) {
    res.errors.push(String((e && e.stack) || e));
  } finally {
    try { await m.close(); } catch (e) { }
  }
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, '_s1_removal.json'), JSON.stringify(res, null, 1));
  console.log('WROTE ' + path.join(OUT, '_s1_removal.json'));
  console.log('ERRORS ' + JSON.stringify(res.errors));
  process.exitCode = res.errors.length ? 1 : 0;
})();
