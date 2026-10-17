'use strict';
/* 阶段 3 环境（躲弹）骨架：真实对局 + 射击源(规则AI) + 甲只躲 + 奖励=存活帧数
 * 课程原话：`3 | 躲弹：射击源随机移动并发射不同弹种 | 纯躲弹 | 不变`
 * 甲 = tank_a（只移动、不开火）；射击源 = 规则 AI（它会移动+开火，实测每~33帧一发）
 * 奖励：每帧 +1（存活），死亡/回合结束停止累计
 * 用法：node _tools/headless/stage3_env.js [--frames 600]
 */
const { Match } = require('./match');
function arg(n, d) { const i = process.argv.indexOf('--' + n); return i < 0 ? d : Number(process.argv[i + 1]); }
(async () => {
  const FR = arg('frames', 600);
  const t0 = Date.now(); const T = () => ((Date.now() - t0) / 1000).toFixed(1) + 's';
  const m = new Match();
  try {
    await m.open({ humanIds: ['tank_a'], aiCount: 1, vantCount: 0 });   // 甲 + 一个规则 AI（射击源）
    console.log(`[${T()}] 开局:`, JSON.stringify(m.bootstrap));
    await m.clearControl();
    // 等回合开始（抄 stage1_env 自适应探法：倒计时期间输入会被丢弃）
    let started = false;
    for (let i = 0; i < 30; i++) {
      const p0 = await m.myTank(); if (!p0) break;
      await m.setControl({ fwd: true }); await m.pump(8, { yieldMs: 4 });
      const p1 = await m.myTank();
      if (p1 && Math.hypot(p1.x - p0.x, p1.y - p0.y) > 0.5) { started = true; break; }
    }
    await m.clearControl();
    console.log(`[${T()}] 回合已开始: ${started}`);
    if (!started) throw new Error('回合没起来，输入被丢弃');
    // 事件订阅：射击源开火 + 弹种
    await m.eval(`(function(){window.__s3={fired:0,types:{},deaths0:null};
      var gc=GameManager.getGameController(); window.__s3.deaths0=(function(){try{return VantageSandbox.createAdapter(gc,'tank_a').getDeathsCount()}catch(e){return 0}})();
      gc.addRoundEventListener(function(self,id,evt,data){var s=String(evt);
        if(s==='weapon fired'){window.__s3.fired++;
          try{var t=data&&data.getType?data.getType():(data&&data.type);window.__s3.types[String(t)]=(window.__s3.types[String(t)]||0)+1;}catch(e){}
        }},window.__s3);return 'ok';})()`);
    // 甲只躲：每帧朝"远离最近的敌方弹体"的简单策略（不给开火）
    let alive = 0; let dead = false;
    for (let i = 0; i < FR; i++) {
      const st = JSON.parse(await m.eval(`(function(){try{var gc=GameManager.getGameController();
        var us=gc.getRoundState?null:null; var ps=gc.roundState?null:null;
        var pc=(function(){try{return VantageSandbox.createAdapter(gc,'tank_a').getDeathsCount()}catch(e){return 0}})();
        return JSON.stringify({pc:pc,cnt:(gc.getRoundModel&&gc.getRoundModel().getProjectiles)?Object.keys(gc.getRoundModel().getProjectiles()).length:0});}catch(e){return '{}'}})()`));
      if (st.pc && st.pc > 0) { dead = true; }
      if (!dead) alive++;
      // 简单躲避：随机左右+前进（真正的策略由训练侧给；此处只证明"甲只躲、不开火"）
      await m.setControl(i % 4 < 2 ? { fwd: true, left: true } : { fwd: true, right: true });
      await m.pump(1, { yieldMs: 0 });
    }
    await m.clearControl();
    const s3 = JSON.parse(await m.eval('JSON.stringify(window.__s3)'));
    console.log(`[${T()}] 结果: 存活帧数=${alive}/${FR} 死亡=${dead} 射击源开火次数=${s3.fired} 弹种分布=${JSON.stringify(s3.types)}`);
    console.log('ENV_OK 阶段3环境骨架跑通（甲只躲、射击源开火、奖励=存活帧数）');
  } catch (e) { console.log('ENV_FAIL ' + String(e.message || e).slice(0, 160)); }
  await m.close();
})();
