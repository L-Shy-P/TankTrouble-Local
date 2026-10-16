'use strict';
/* 验证「不呈现」开关的两条集成路径是否真的生效（不是"改了等于没改"）：
 *   ① 默认（不带任何开关）⟹ 页面侧源码【根本不该被装上】（零侵入）
 *   ② opts.noRender:true     ⟹ 应看到 canvas 1×1 + display:none + renderNoop=true
 *   ③ 环境变量 VT_NO_RENDER=1（用 env 跑本脚本时，路径 ① 应变成"已生效"）
 * 用法：node _tools/headless/_verify_norender_tmp.js
 */
const { Match } = require('./match');
async function probe(tag, opts) {
  const m = new Match();
  await m.open(Object.assign({ humanIds: ['tank_a'], aiCount: 1, vantCount: 1 }, opts));
  const has = await m.eval('typeof window.__vtNoRenderInfo');
  let info;
  if (has === 'function') info = JSON.parse(await m.eval('JSON.stringify(window.__vtNoRenderInfo())'));
  else info = JSON.parse(await m.eval('(function(){var g=GameManager.getGame();return JSON.stringify({installed:false,canvas:{w:g.canvas.width,h:g.canvas.height,display:g.canvas.style.display},renderIsOwn:Object.prototype.hasOwnProperty.call(g.renderer,"render")});})()'));
  console.log('VERIFY ' + tag + ' pageSrcInstalled=' + (has === 'function') + ' ' + JSON.stringify(info));
  await m.close();
}
(async () => {
  console.log('VERIFY ENV_VT_NO_RENDER=' + JSON.stringify(process.env.VT_NO_RENDER || null));
  await probe('CASE1_default(no flag)', {});
  await probe('CASE2_opts.noRender=true', { noRender: true });
})().catch(e => { console.log('PROBE_FATAL ' + String((e && e.stack) || e)); process.exit(1); });
