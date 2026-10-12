'use strict';
/* 1-2④ 接线验证：追踪导弹「换目标 → 刷新」
 *   反向验证（纪律③）：
 *     A 对照组（不改目标）  → 不应出现 '导弹换目标-刷新'事件
 *     B 实验组（目标变了）   → 必须出现该事件（=新接线真的跑了）
 *   用法：node _tools/headless/_probe_missile_retarget_refresh.js
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Match } = require('./match');

const FILES = [
  'game_core/js/vantage_tree.js',
  'game_core/js/vantage_sandbox.js',
  'game_core/index.html',
];
const P = (s) => console.log(s);

(async () => {
  const out = { fingerprints: [] };
  for (const rel of FILES) {
    const p = path.join(__dirname, '..', '..', rel);
    const st = fs.statSync(p);
    out.fingerprints.push({ file: rel, mtime: st.mtime.toISOString(),
      md5: crypto.createHash('md5').update(fs.readFileSync(p)).digest('hex') });
  }
  P('=== 指纹 ===');
  for (const f of out.fingerprints) P(`  ${f.file}  ${f.mtime}  ${f.md5}`);

  const m = new Match();
  try {
    await m.open({ humanIds: ['tank_a'], aiCount: 1, vantCount: 1, bootFrames: 300, rebaseAtMenu: true });
    P('  open ok; VantageTree.VERSION=' + await m.eval('VantageTree.VERSION'));
    // 等树建出来
    let tree0 = null;
    for (let i = 0; i < 240; i++) {
      await m.pump(4);
      tree0 = await m.eval(`(() => { try { var t = VantageTree.getTree(); return t ? { nodes: t.stats ? t.stats.nodes : -1, active: !!t.active, rebuilds: t.stats ? t.stats.rebuilds : -1 } : null; } catch (e) { return { err: String(e.message || e) }; } })()`);
      if (tree0 && tree0.active) break;
    }
    P('  tree: ' + JSON.stringify(tree0));
    // 种一颗"追踪导弹"（客户端 API，和真弹同构：type=3，owner=tank_a）
    const seeded = await m.eval(`(() => {
      var gc = GameManager.getGameController();
      var t = gc.getTank('tank_a') || gc.getTank('vantage_1');
      var x = t ? t.getX() + 12 : 40, y = t ? t.getY() : 40;
      var ps = ProjectileState.withState('probe_hm_rt','tank_a',3, x, y, -18, 0);
      gc.roundController.setProjectileState(ps);
      var p = gc.getProjectile('probe_hm_rt');
      return p ? { id: p.getId(), tgt: p.currentTargetPlayerId, ta: p.getTimeAlive() } : null;
    })()`);
    P('  seeded missile: ' + JSON.stringify(seeded));
    const evN = async () => (await m.eval("(() => { var d = VantageTree.dumpDiagnostics(); return (d.events||[]).length; })()"));
    const evs = async () => (await m.eval("(() => { var d = VantageTree.dumpDiagnostics(); return (d.events||[]).filter(function(e){return String(e.info||'').indexOf('导弹换目标')>=0;}); })()"));
    // A) 对照组：不动目标，跑 30 帧
    await m.pump(30);
    const aEv = await evs();
    P('  [A 对照] 不换目标 30 帧 → 新接线事件数 = ' + aEv.length + ' ' + JSON.stringify(aEv));
    // B) 实验组：把导弹的目标改掉（直接写弹上的字段 = 模拟"游戏里换目标"）
    const flip = await m.eval(`(() => {
      var p = GameManager.getGameController().getProjectile('probe_hm_rt');
      if (!p) return { err: 'missile gone' };
      var before = p.currentTargetPlayerId;
      p.currentTargetPlayerId = 'tank_b';
      return { before: before, after: p.currentTargetPlayerId };
    })()`);
    P('  [B] flip target: ' + JSON.stringify(flip));
    await m.pump(4);
    const bEv = await evs();
    P('  [B 实验] 换目标后 4 帧 → 新接线事件数 = ' + bEv.length);
    for (const e of bEv.slice(0, 3)) P('     ' + JSON.stringify(e));
    // C) 再改回来（反向对照）
    await m.eval(`(() => { var p = GameManager.getGameController().getProjectile('probe_hm_rt'); if (p) p.currentTargetPlayerId = 'tank_a'; return 1; })()`);
    await m.pump(60);   // 树 tick 不是每帧都跑（AI 控制未开）⟹ 给足帧数，否则"没触发"不可解释
    const cEv = await evs();
    P('  [C 反向] 改回 tank_a 后 → 累计事件数 = ' + cEv.length);
    out.A = { events: aEv.length };
    out.B = { events: bEv.length, sample: bEv.slice(0, 3) };
    out.C = { events: cEv.length };
    out.verdict = (aEv.length === 0 && bEv.length >= 1) ? 'PASS（对照不触发 / 换目标触发）' : 'FAIL';
    P('  ★ 判定: ' + out.verdict);
    P('  pageErrors: ' + JSON.stringify(m.pageErrors.slice(0, 4)));
  } catch (e) {
    out.err = String((e && e.stack) || e); P('FATAL: ' + out.err); process.exitCode = 1;
  } finally {
    fs.writeFileSync(path.join(__dirname, 'prof', 'probe_missile_retarget.json'), JSON.stringify(out, null, 1));
    try { await m.close(); } catch (e) {}
    P('[done]');
  }
})();
