
    /* ============ B. wpn 哨兵实测 ============ */
    const snapshot = async (tag) => ({
      tag: tag,
      wpn: await m.eval('window.__i4x.wpnRows()'),
      wpnJSON: await m.eval('window.__i4x.wpnJSON()'),
      detail: await m.eval('window.__i4x.weaponDetail()')
    });
    try {
      out.B.steps = [];
      out.B.steps.push(await snapshot('开局默认(BULLET)'));
      for (const kind of ['HOMING', 'LASER', 'MINE', 'SHOTGUN', 'GATLING']) {
        out.B['inject_' + kind] = await m.eval(`window.__i4x.injectWeapon(${JSON.stringify(kind)}, 'tank_a')`);
        await m.pump(1, { yieldMs: 0 });
        out.B.steps.push(await snapshot('注入 ' + kind + ' 后'));
      }
      out.B['inject_HOMING2'] = await m.eval("window.__i4x.injectWeapon('HOMING','tank_a')");
      await m.pump(1, { yieldMs: 0 });
      const beforeFire = await snapshot('发射前(HOMING)');
      await m.setControl({ fire: true }); await m.pump(3, { yieldMs: 0 }); await m.setControl({ fire: false });
      await m.pump(2, { yieldMs: 0 });
      const afterFire = await snapshot('发射后(HOMING)');
      out.B.fired = {
        wpnJSON_before: beforeFire.wpnJSON, wpnJSON_after: afterFire.wpnJSON,
        wpnChanged: beforeFire.wpnJSON !== afterFire.wpnJSON,
        tankA_fields_after: (afterFire.detail || []).filter((w) => w.owner === 'tank_a'),
        projN: await m.eval('window.__i4x.bulletsOk().length')
      };
      out.B.pageErr = m.pageErrors.slice(0, 3);
    } catch (e) { out.B.err = String((e && e.stack) || e); }
  } catch (e) {
    out.err = String((e && e.stack) || e);
    try { out.pageErrors = m.pageErrors.slice(0, 5); } catch (e2) {}
  } finally {
    try { fs.writeFileSync(path.join(OUT, '_i4x_vx_wpn_check.json'), JSON.stringify(out, null, 2)); } catch (e) {}
    try { await m.close(); } catch (e) {}
  }
  console.log(JSON.stringify(out, null, 2));
})();
