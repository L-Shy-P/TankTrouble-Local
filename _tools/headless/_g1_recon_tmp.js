/**
 * G1 侦察（第一步，只回答两个问题）：
 *   ① `aiCount=1 + vantCount=1`、没有人类玩家，能不能开成一局并进 IN_ROUND？
 *   ② 把 VantageTree 的 A/B 两个智能体槽接到我们的桥（bundle = picks[{nodeId,back:0}]）后，
 *      Vantage 的坦克会不会【真的动】？
 * 不改任何产品代码；退出时关掉自己开的浏览器。
 */
const fs = require('fs');
const { Match } = require('./match');
const SRC = fs.readFileSync(__dirname + '/_g1_inject.js', 'utf8');

const brief = (s) => (s.players || []).map(function (p) {
  var tt = (s.pl || {})[p];
  return p + (tt ? '@(' + tt.x + ',' + tt.y + ',r' + tt.rot + ')' : '@null');
}).join(' ') + ' proj=' + s.projN + ' projBy=' + JSON.stringify(s.projBy) + (s.err ? ' ERR=' + s.err : '');

(async () => {
  const m = new Match();
  try {
    await m.open({ humanIds: [], aiCount: 1, vantCount: 1, control: false });
    console.log('BOOTSTRAP ' + JSON.stringify(m.bootstrap));
    console.log('BOOT_FRAMES ' + JSON.stringify(m.bootFrames));
    await m.eval(SRC);
    const meta = await m.eval('JSON.stringify(window.__g1.meta())');
    console.log('META ' + meta);

    // ── 阶段 1：不接线（规则模式），看 Laika / Vantage 各自动没动
    for (let i = 0; i < 4; i++) {
      const s = JSON.parse(await m.eval('window.__g1.step(0)'));
      console.log('P1 f=' + s.f + ' state=' + s.state + ' N=' + s.N + ' ' + brief(s));
      await m.pump(60, { yieldMs: 0 });
    }
    const s1 = JSON.parse(await m.eval('window.__g1.step(0)'));
    console.log('P1_LAST state=' + s1.state + ' ' + brief(s1));
    console.log('DIMS ' + JSON.stringify(s1.dims));
    console.log('WEP ' + JSON.stringify(s1.wep));

    // ── 阶段 2：接桥 + 固定 nodeId=0（把"树能不能驱动坦克"独立出来）
    console.log('SETUP ' + await m.eval('window.__g1.setup()') + ' tb=' +
      JSON.stringify(await m.eval('JSON.stringify(VantageTestbench.getState().aiControl)')));
    for (let i = 0; i < 6; i++) {
      const s = JSON.parse(await m.eval('window.__g1.step(0)'));
      console.log('P2 f=' + s.f + ' state=' + s.state + ' N=' + s.N + ' ' + brief(s));
      await m.pump(60, { yieldMs: 0 });
    }
    const s2 = JSON.parse(await m.eval('window.__g1.step(0)'));
    console.log('P2_LAST state=' + s2.state + ' ' + brief(s2));
    console.log('IFACE ' + JSON.stringify(await m.eval(
      'JSON.stringify((function(){var T=VantageTree;return {nKeys:T?Object.keys(T).length:null};})())')));
  } catch (e) {
    console.error('FAILED ' + ((e && e.stack) || e));
    process.exitCode = 1;
  } finally { await m.close(); }
})();
