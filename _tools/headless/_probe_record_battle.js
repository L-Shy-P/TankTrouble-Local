'use strict';
/* 实战录像：用【当前 build】跑一局（1 人操 + 1 Laika + 1 vantage），
 * 靠树自己内建的 auto-death 录制器成档，导出 vantage_record_*.json 到 game_core/测试反馈/。
 * 用法: node _tools/headless/_probe_record_battle.js [--max=1800]
 */
const fs = require('fs'), path = require('path');
const { Match } = require('./match');
const argv = process.argv.slice(2);
const num = (n, d) => { const i = argv.indexOf('--' + n); return i < 0 ? d : Number(argv[i + 1]); };
const MAX = num('max', 1800);
const MODE = (argv.find((a) => a.startsWith('--mode=')) || '--mode=auto').split('=')[1];
const OUTDIR = path.join(__dirname, '..', '..', 'game_core', '测试反馈');

(async () => {
  const m = new Match();
  try {
    await m.open({ humanIds: ['tank_a'], aiCount: 1, vantCount: 1 });
    const ver = await m.eval('VantageTree.VERSION');
    console.log('treeVersion=' + ver);
    let deaths = 0, f = 0, stopped = false, started = false;
    const tMark = { t: Date.now(), f: 0 };
    for (; f < MAX; f++) {
      if (MODE === 'manual' && f === 100) { await m.eval("VantageTree.startRecord('manual')"); started = true; console.log('  [100] 手动开始录制'); }
      if (MODE === 'auto' && !started) { started = true; }
      if (started && f % 50 === 0 && f > 150) { console.log('  进度 f=' + f + ' 近50帧墙钟=' + (Date.now() - tMark.t) + 'ms'); tMark.t = Date.now(); }
      if (f % 30 === 0) {
        const rot = (f / 30) * 0.3;
        await m.eval(`(() => { var gc = GameManager.getGameController(); var a = gc.getTank ? gc.getTank('tank_a') : null;
          if (a && gc.setTankState) gc.setTankState(TankState.withState('tank_a', a.getX(), a.getY(), false,false, ${rot}, false,false,true,false), false);
          window.__vtCtrl.fire = true; return 1; })()`).catch(() => {});
      }
      await m.pump(1);
      if (f % 5 === 0) {
        const pk = await m.eval('VantageTree.peekRecord ? VantageTree.peekRecord() : null').catch(() => null);
        if (pk) {
          if (pk.deaths > deaths) { deaths = pk.deaths; console.log('  [' + f + '] 死亡事件=' + deaths + ' 录制中=' + pk.on + ' 缓冲=' + pk.frames); }
          if (deaths > 0 && !pk.on) { stopped = true; console.log('  [' + f + '] auto-death 录制已收尾（缓冲 ' + pk.frames + ' 帧）'); break; }
          if (started && f > Number((argv.find((a)=>a.startsWith('--stop='))||'--stop=550').split('=')[1])) { console.log('  [' + f + '] 手动录制已够长（缓冲 ' + pk.frames + ' 帧），收工'); break; }
        }
      }
    }
    const rec = await m.eval('VantageTree.exportRecord()');
    const ts = Date.now();
    const file = path.join(OUTDIR, 'vantage_record_' + ts + '.json');
    fs.writeFileSync(file, JSON.stringify(rec));
    console.log('导出=' + file + ' 字节=' + fs.statSync(file).size + ' 帧=' + rec.frames +
      ' startReason=' + rec.startReason + ' treeVersion=' + rec.meta.treeVersion +
      ' deaths=' + (rec.deaths || []).length + ' frameDt=' + rec.meta.frameDt);
  } catch (e) {
    console.error('FAILED:', (e && e.stack) || e);
    process.exitCode = 1;
  } finally { await m.close(); }
})();
