'use strict';
/* 只读事实探针：激光判死链路上的"机制证据"
 *   - 激光弹体：shape 半径 / IsBullet()（CCD 标记）
 *   - 坦克车体：body 类型 / 夹具是否 sensor / 夹具多边形
 *   - 世界：m_continuousPhysics（连续物理开关）
 *   - RoundModel 事件流里 TANK|PROJECTILE 的处理（SetEnabled(false)）
 * 用法：node _tools/headless/_probe_laser_facts.js
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Match } = require('./match');

const FILES = [
  'game_core/js/f1a5ef972c273fb89a098cb50b0f22e7.js',
  'game_core/js/b714588dc4621fe104113111ba90b1a7.js',
  'game_core/js/vantage_sandbox.js',
  'game_core/js/vantage_tree.js',
  '_tools/headless/match.js',
  '_tools/headless/clock.js',
];
const OUT = { fingerprints: [], facts: [] };
const P = (s) => { console.log(s); OUT.facts.push(s); };

(async () => {
  const m = new Match();
  try {
    for (const rel of FILES) {
      const p = path.join(__dirname, '..', '..', rel);
      const st = fs.statSync(p);
      OUT.fingerprints.push({ file: rel, mtime: st.mtime.toISOString(), md5: crypto.createHash('md5').update(fs.readFileSync(p)).digest('hex') });
    }
    P('=== 指纹 ===');
    for (const f of OUT.fingerprints) P(`  ${f.file} ${f.mtime} ${f.md5}`);

    await m.open({ humanIds: ['tank_a', 'tank_b'], aiCount: 0, vantCount: 0 });
    P(`  open: ${JSON.stringify(m.roundWait)}`);
    // 给 tank_a 激光
    const gived = await m.eval(`(() => {
      var gc = GameManager.getGameController();
      var ws = LaserWeapon.createInitialWeaponState(IdGenerator.instance.gen('lw'), 'tank_a');
      gc.roundController.setWeaponState(ws);
      var w = gc.getActiveWeapon('tank_a');
      return { activeType: w ? w.getType() : null };
    })()`);
    P('  给武器: ' + JSON.stringify(gived));

    const worldFacts = await m.eval(`(() => {
      var gc = GameManager.getGameController();
      var w = gc.getB2DWorld();
      return {
        continuousPhysics: (Box2D && Box2D.Dynamics && Box2D.Dynamics.b2World)
          ? Box2D.Dynamics.b2World.m_continuousPhysics : 'n/a',
        warmStarting: (Box2D && Box2D.Dynamics && Box2D.Dynamics.b2World)
          ? Box2D.Dynamics.b2World.m_warmStarting : 'n/a',
        gravity: [w.GetGravity().x, w.GetGravity().y],
        allowSleep: w.m_allowSleep,
      };
    })()`);
    P('  世界: ' + JSON.stringify(worldFacts));

    const tankFacts = await m.eval(`(() => {
      var gc = GameManager.getGameController();
      var t = gc.getTank('tank_b'), b = t.getB2DBody();
      var out = { bodyType: b.GetType(), isBullet: b.IsBullet(), isDynamic: b.IsDynamic(),
                  fixtures: [] };
      for (var f = b.GetFixtureList(); f; f = f.GetNext()) {
        out.fixtures.push({ sensor: f.IsSensor(), cat: f.GetFilterData().categoryBits,
            mask: f.GetFilterData().maskBits, type: (f.GetUserData() || {}).type,
            shapeRadius: (f.GetShape().m_radius === undefined ? null : f.GetShape().m_radius) });
      }
      out.dynamicBodyConst = Box2D.Dynamics.b2Body.b2_dynamicBody;
      return out;
    })()`);
    P('  坦克(tank_b)夹具: ' + JSON.stringify(tankFacts));

    await m.eval(`window.__vtTankId = 'tank_a'; 1`);
    await m.setControl({ fwd: false, back: false, left: false, right: false, fire: false });
    const a0 = await m.eval(`(() => { var t=GameManager.getGameController().getTank('tank_a'); return {x:t.getX(),y:t.getY(),rot:t.getRotation()}; })()`);
    await m.pump(6);
    await m.setControl({ fire: true });
    await m.pump(1);
    await m.setControl({ fire: false });
    await m.pump(1);
    const laserFacts = await m.eval(`(() => {
      var gc = GameManager.getGameController(), ps = gc.getProjectiles();
      for (var k in ps) {
        var p = ps[k];
        if (p.getType() !== 0) continue;
        var b = p.getB2DBody(), f = b.GetFixtureList();
        return { id: k, type: p.getType(), lifetime: p.lifetime, timeAlive: p.getTimeAlive(),
                 bodyType: b.GetType(), isBullet: b.IsBullet(), isDynamic: b.IsDynamic(),
                 shape: f.GetShape().GetType(), shapeRadius: f.GetShape().m_radius,
                 fixtureRadius: f.GetShape().m_radius, density: 0.01,
                 cat: f.GetFilterData().categoryBits, mask: f.GetFilterData().maskBits,
                 deadlyToOwner: p.isDeadlyToOwner(), bounces: p.bounces.length,
                 hasClass: Object.getPrototypeOf(p).constructor.name };
      }
      return null;
    })()`);
    P('  激光弹体: ' + JSON.stringify(laserFacts));
    P('  （对比：LASER.RADIUS.m=' + await m.eval('Constants.LASER.RADIUS.m') +
      '，LASER.SPEED.m=' + await m.eval('Constants.LASER.SPEED.m') +
      '，LASER_MAX_LIFETIME=' + await m.eval('Constants.LASER_MAX_LIFETIME') +
      '，TANK.WIDTH.m=' + await m.eval('Constants.TANK.WIDTH.m') +
      '，TANK.HEIGHT.m=' + await m.eval('Constants.TANK.HEIGHT.m') + '）');
    P('  弹数: ' + JSON.stringify(await m.projectileCount()) + '，页面异常: ' + JSON.stringify(m.pageErrors.slice(0, 3)));
  } catch (e) {
    OUT.err = String((e && e.stack) || e);
    console.error('FATAL:', OUT.err);
  } finally {
    fs.writeFileSync(path.join(__dirname, 'prof', 'probe_laser_facts.json'), JSON.stringify(OUT, null, 1));
    try { await m.close(); } catch (e) {}
    await new Promise((r) => setTimeout(r, 300));
    process.exit(0);
  }
})();
