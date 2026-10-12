
function findLane(ti, minLen) {
  const rows = {}, cols = {};
  for (const c of ti.cells) { (rows[c.y] = rows[c.y] || []).push(c); (cols[c.x] = cols[c.x] || []).push(c); }
  function scan(map, horiz) {
    let best = null;
    for (const k of Object.keys(map)) {
      const line = map[k].slice().sort((a, b) => (horiz ? a.x - b.x : a.y - b.y));
      let run = [line[0]];
      for (let i = 1; i < line.length; i++) {
        const p = line[i - 1], c = line[i];
        const adj = horiz ? (c.x === p.x + 1 && c.left === 0) : (c.y === p.y + 1 && c.top === 0);
        if (adj) run.push(c); else { if (!best || run.length > best.length) best = run; run = [c]; }
      }
      if (!best || run.length > best.length) best = run;
    }
    return best;
  }
  const h = scan(rows, true), v = scan(cols, false);
  if (h && h.length >= minLen) return { axis: 'x', cells: h.slice(0, minLen) };
  if (v && v.length >= minLen) return { axis: 'y', cells: v.slice(0, minLen) };
  return null;
}
const lanePose = (lane, idx) => lane.axis === 'x'
  ? { x: lane.cells[idx].x * TILE + TILE / 2, y: lane.cells[idx].y * TILE + TILE / 2, rot: Math.PI / 2 }
  : { x: lane.cells[idx].x * TILE + TILE / 2, y: lane.cells[idx].y * TILE + TILE / 2, rot: 0 };

(async () => {
  const out = { startedAt: new Date().toISOString(), A: {}, B: {} };
  let m;
  try {
    fs.mkdirSync(OUT, { recursive: true });
    m = new Match();
    await m.open({ humanIds: ['tank_a', 'tank_b'], aiCount: 0, vantCount: 0 });
    await m.clearControl();
    await m.eval(HELPERS);
    out.weaponTypes = await m.eval('window.__i4x.weaponTypes()');

    /* ============ A. vx 实测 + 正打护盾反弹重测 ============ */
    try {
      await m.setControl({ fire: true }); await m.pump(3, { yieldMs: 0 }); await m.setControl({ fire: false });
      let seen = 0;
      for (let i = 0; i < 40; i++) { seen = await m.eval('window.__i4x.bulletsOk().length'); if (seen) break; await m.pump(1, { yieldMs: 0 }); }
      out.A.liveFrame = { n: seen,
        buggy: await m.eval('window.__i4x.bullets4c()'),
        fixed: await m.eval('window.__i4x.bulletsOk()') };
      out.A.vx恒null = (out.A.liveFrame.buggy || []).every((b) => b.vx === null) &&
                       (out.A.liveFrame.fixed || []).every((b) => typeof b.vx === 'number');

      const ti = await m.eval('window.__i4x.tileInfo()');
      const lane = findLane(ti, 5);
      out.A.lane = lane ? { axis: lane.axis, cells: lane.cells.map((c) => c.x + ',' + c.y) } : null;
      if (lane) {
        const near = lanePose(lane, lane.cells.length - 2), far = lanePose(lane, lane.cells.length - 1);
        out.A.pose = { shooter: far, target: near };
        await m.teleport('tank_b', near.x, near.y, near.rot);
        await m.pump(3, { yieldMs: 0 });
        out.A.crateId = await m.eval(`window.__i4x.spawnCrate(6, ${near.x}, ${near.y}, 0)`);
        for (let i = 0; i < 12; i++) { await m.pump(1, { yieldMs: 0 }); if ((await m.eval("window.__i4x.upgrades('tank_b')")).length) break; }
        out.A.shieldUpgrade = await m.eval("window.__i4x.upgrades('tank_b')");
        out.A.fixtures = await m.eval("window.__i4x.fixtures('tank_b')");
        const shield = (out.A.fixtures || []).find((f) => f.cat === 32);
        out.A.shieldR = shield ? shield.r : null;
        await m.teleport('tank_a', far.x, far.y, far.rot);
        await m.pump(3, { yieldMs: 0 });
        await m.setControl({ fire: true }); await m.pump(1, { yieldMs: 0 }); await m.setControl({ fire: false });
        const rows = []; let any = false;
        for (let i = 0; i <= 200; i++) {
          const bg = await m.eval('window.__i4x.bullets4c()');
          const ok = await m.eval('window.__i4x.bulletsOk()');
          const tb = await m.eval("(()=>{var t=window.__i4x.gc().getTank('tank_b');return t?{x:t.getX(),y:t.getY()}:null})()");
          rows.push({ f: i, bg: bg, ok: ok, tb: tb });
          if (bg.length) any = true; else if (any) break;
          await m.pump(1, { yieldMs: 0 });
        }
        const used = rows.filter((r) => r.bg.length);
        let flipBuggy = -1, flipFixed = -1;
        for (let i = 1; i < used.length; i++) {
          const dvg = Math.hypot(used[i].bg[0].vx - used[i - 1].bg[0].vx, used[i].bg[0].vy - used[i - 1].bg[0].vy);
          const dvf = Math.hypot(used[i].ok[0].vx - used[i - 1].ok[0].vx, used[i].ok[0].vy - used[i - 1].ok[0].vy);
          if (flipBuggy < 0 && dvg > 1e-6) flipBuggy = i;
          if (flipFixed < 0 && dvf > 1e-6) flipFixed = i;
        }
        const minDist = used.length && used[0].tb
          ? +Math.min(...used.map((r) => Math.hypot(r.ok[0].x - r.tb.x, r.ok[0].y - r.tb.y))).toFixed(3) : null;
        const tail = used.slice(-3).map((r) => ({ f: r.f, x: r.ok[0].x, y: r.ok[0].y, vx: r.ok[0].vx, vy: r.ok[0].vy, bg_vx: r.bg[0].vx }));
        out.A.headOn = {
          bulletsSeen: used.length, flipBuggy: flipBuggy, flipFixed: flipFixed,
          minDistToTargetCenter: minDist,
          firstRow_ok: used.length ? used[0].ok[0] : null,
          lastRow_ok: used.length ? used[used.length - 1].ok[0] : null,
          head: used.slice(0, 4).map((r) => ({ f: r.f, x: r.ok[0].x, vx: r.ok[0].vx, bg_vx: r.bg[0].vx })),
          tail: tail
        };
      }
    } catch (e) { out.A.err = String((e && e.stack) || e); }
