'use strict';
/* 实测：v5 记录器对【各弹种】产出的 hs.wpn 行（走真路径：__vtRec.start → chunk → 解析帧）
 * 只写 _tools/headless/_i4x_prof/；不改产品代码。
 */
const fs = require('fs'), path = require('path');
const { Match } = require('./match');
const OUT = path.join(__dirname, '_i4x_prof');

(async () => {
  const res = { startedAt: new Date().toISOString(), rows: {} };
  const m = new Match();
  try {
    await m.open({ humanIds: ['tank_a', 'tank_b'], aiCount: 0, vantCount: 0 });
    await m.clearControl();
    await m.eval(`window.__i4xw = {
      inject: function (kind, id) {
        var gc = GameManager.getGameController(); var ws = null, C = Constants;
        if (kind === 'HOMING') ws = HomingMissileWeapon.createInitialWeaponState(IdGenerator.instance.gen('hmw'), id);
        else if (kind === 'LASER') ws = LaserWeapon.createInitialWeaponState(IdGenerator.instance.gen('lw'), id);
        else if (kind === 'MINE') ws = MineWeapon.createInitialWeaponState(IdGenerator.instance.gen('mw'), id, C.MINE_AMMO_COUNT);
        else if (kind === 'SHOTGUN') ws = ShotgunWeapon.createInitialWeaponState(IdGenerator.instance.gen('sw'), id, C.SHOTGUN_AMMO_COUNT);
        else if (kind === 'GATLING') ws = GatlingGunWeapon.createInitialWeaponState(IdGenerator.instance.gen('ggw'), id, C.GATLING_AMMO_COUNT);
        else return { err: 'kind?' };
        gc.roundController.setWeaponState(ws);
        return { ok: true, id: ws.getId(), type: ws.getType() };
      },
      rec1: function () {   // 起一次录制、推 2 帧、把第 2 帧原样取出来
        var r = window.__vtRec.start({});
        return { started: !!r.started };
      },
      grab: function () { var c = window.__vtRec.chunk(0, 3); return c.records.map(function (s) { return JSON.parse(s); }); },
      stop: function () { return window.__vtRec.stop(); }
    }`);
    for (const kind of ['BULLET(默认)', 'HOMING', 'LASER', 'MINE', 'SHOTGUN', 'GATLING']) {
      if (kind !== 'BULLET(默认)') await m.eval(`window.__i4xw.inject(${JSON.stringify(kind)}, 'tank_a')`);
      await m.pump(1, { yieldMs: 0 });
      await m.eval('window.__i4xw.rec1()');
      await m.pump(2, { yieldMs: 0 });
      await m.eval('window.__i4xw.stop()');
      const fr = await m.eval('window.__i4xw.grab()');
      const hs = (fr[fr.length - 1] || {}).hs || {};
      res.rows[kind] = { wpn: hs.wpn, wpnN: hs.wpnN, v: (fr[fr.length - 1] || {}).k };
    }
    res.pageErr = m.pageErrors.slice(0, 3);
  } catch (e) { res.err = String((e && e.stack) || e); }
  finally { try { await m.close(); } catch (e) {} }
  fs.writeFileSync(path.join(OUT, '_i4x_wpn_v5_measure.json'), JSON.stringify(res, null, 2));
  console.log(JSON.stringify(res, null, 2));
})();
