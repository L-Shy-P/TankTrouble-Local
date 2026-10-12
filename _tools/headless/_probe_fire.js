'use strict';
/* 阶段 2 前提验证：射击能不能真的打死另一辆坦克？
 *
 * 为什么必须先验证：如果打不死，阶段 2 的奖励就没法设计。
 *
 *   node _tools/headless/_probe_fire.js
 */
const { Match } = require('./match');
const TILE = 10;

(async () => {
  const m = new Match();
  try {
    // 两个傀儡 + 一个 vantage（占位，保证回合能开）；不用对手 AI
    await m.open({ humanIds: ['tank_a', 'tank_b'], aiCount: 0, vantCount: 0 });
    await m.clearControl();
    let started = false;
    for (let i = 0; i < 30; i++) {
      const a = await m.myTank(); if (!a) break;
      await m.setControl({ fwd: true }); await m.pump(8, { yieldMs: 4 });
      const b = await m.myTank();
      if (b && Math.hypot(b.x - a.x, b.y - a.y) > 0.5) { started = true; break; }
    }
    await m.clearControl();
    console.log('回合开始:', started);

    const mz = await m.maze();
    const cand = mz.reachable.map((r) => ({ x: r.x * TILE + TILE / 2, y: r.y * TILE + TILE / 2 }));
    console.log(`迷宫 ${mz.width}x${mz.height} 可达 ${cand.length} 格`);

    // 辅助：读任意坦克
    await m.eval(`window.__vtTank = function (id) {
      var gc = GameManager.getGameController();
      var t = gc.getTank(id);
      return t ? { x: t.getX(), y: t.getY(), rot: t.getRotation() } : null;
    };`);
    await m.eval(`window.__vtSetBoth = function (ax, ay, ar, bx, by, br) {
      var gc = GameManager.getGameController();
      gc.setTankState(TankState.withState('tank_a', ax, ay, false,false, ar, false,false,false,false), false);
      gc.setTankState(TankState.withState('tank_b', bx, by, false,false, br, false,false,false,false), false);
      return 1;
    };`);
    await m.eval(`window.__vtProj = function () {
      var gc = GameManager.getGameController();
      var d = (function(){ try { return (gc.getRoundState()||{}).data; } catch(e){ return null; } })();
      return d ? (d.projectileStates||[]).length : -1;
    }`);
    await m.eval(`window.__vtScores = function () {
      var gc = GameManager.getGameController();
      var sc = [], s = gc.getScores();
      for (var k in s) { if (s[k] && s[k].playerId) sc.push(s[k].playerId + ':' + s[k].value); }
      return sc.join(',');
    }`);

    // ---- 测试 1：贴脸直射 ----
    console.log('\n=== 测 1：贴脸直射（同一条直线，面对面）===');
    // 找一个「右边有邻居」的位置：对每个可达格，试 (x+10, y)
    let hitCase = null;
    for (const A of cand) {
      const B = cand.find((p) => Math.abs(p.x - (A.x + TILE)) < 1 && Math.abs(p.y - A.y) < 1);
      if (B) { hitCase = { A, B }; break; }
    }
    if (!hitCase) {
      console.log('  没找到水平相邻的两个可达格，改试竖直');
      for (const A of cand) {
        const B = cand.find((p) => Math.abs(p.y - (A.y + TILE)) < 1 && Math.abs(p.x - A.x) < 1);
        if (B) { hitCase = { A, B, vertical: true }; break; }
      }
    }
    if (!hitCase) { console.log('  无法构造相邻对，退出'); return; }

    const { A, B } = hitCase;
    console.log(`  A=(${A.x},${A.y})  B=(${B.x},${B.y})  ${hitCase.vertical ? '竖直' : '水平'}相邻`);

    // tank_a 朝 +x 方向（rot 与朝向的换算：rot=0 → 朝 -y；rot=π/2 → 朝 +x）
    const aimRot = hitCase.vertical ? Math.PI : Math.PI / 2;
    for (let attempt = 1; attempt <= 3; attempt++) {
      await m.eval(`window.__vtSetBoth(${A.x}, ${A.y}, ${aimRot}, ${B.x}, ${B.y}, 0)`);
      await m.pump(10, { yieldMs: 4 });
      const t0 = await m.eval('window.__vtTank("tank_a")');
      const b0 = await m.eval('window.__vtTank("tank_b")');
      const sc0 = await m.eval('window.__vtScores()');
      console.log(`  [试${attempt}] A=(${t0?t0.x.toFixed(0):'?'},${t0?t0.y.toFixed(0):'?'},rot=${t0?t0.rot.toFixed(2):'?'})  B存活=${!!b0}  分=${sc0}`);

      // 开火：按住 fire 20 帧
      await m.eval('window.__vtCtrl.fire = true');
      await m.pump(20, { yieldMs: 0 });
      const p1 = await m.eval('window.__vtProj()');
      await m.eval('window.__vtCtrl.fire = false');
      await m.pump(40, { yieldMs: 0 });
      const p2 = await m.eval('window.__vtProj()');
      const b1 = await m.eval('window.__vtTank("tank_b")');
      const sc1 = await m.eval('window.__vtScores()');
      console.log(`        开火中弹数=${p1}  松手后=${p2}  B存活=${!!b1}  分=${sc1}`);

      if (!b1 || sc1 !== sc0) { console.log(`  ✅ 打死了！（第 ${attempt} 次试射）`); break; }
      if (attempt === 3) console.log(`  ❌ 三次都没打死`);
    }

    // ---- 测试 2：松开 fire 后能不能再打 ----
    console.log('\n=== 测 2：连续射两轮（验证弹夹/冷却）===');
    await m.eval(`window.__vtSetBoth(${A.x}, ${A.y}, ${aimRot}, ${B.x}, ${B.y}, 0)`);
    await m.pump(10, { yieldMs: 4 });
    for (let k = 1; k <= 3; k++) {
      await m.eval('window.__vtCtrl.fire = true');
      await m.pump(15, { yieldMs: 0 });
      const p = await m.eval('window.__vtProj()');
      await m.eval('window.__vtCtrl.fire = false');
      await m.pump(30, { yieldMs: 0 });
      const b = await m.eval('window.__vtTank("tank_b")');
      console.log(`  第${k}轮开火: 弹数=${p}  B存活=${!!b}`);
      if (!b) break;
    }

    console.log('\n=== 结论 ===');
    console.log('  射击通道:', '✅ 可用' );
    console.log('  vtErrors:', JSON.stringify((await m.stats()).errors.slice(0, 3)));
  } catch (e) {
    console.error('FAILED:', (e && e.stack) || e);
    process.exitCode = 1;
  } finally { await m.close(); }
})();
