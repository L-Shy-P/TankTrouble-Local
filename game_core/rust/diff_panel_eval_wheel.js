#!/usr/bin/env node
// v147 回归：面板必须提供精确 evalFrames 输入/滚轮 ±1 逻辑
'use strict';
const fs=require('fs'),path=require('path'),assert=require('assert');
const root=path.resolve(__dirname,'..');
const s=fs.readFileSync(path.join(root,'js','vantage_testbench.js'),'utf8');
assert(s.includes('data-act="exp-frames-number"'),'缺少精确帧数输入框');
assert(s.includes("addEventListener('wheel'"),'滑块缺 wheel 事件');
assert(s.includes('e.deltaY < 0 ? 1 : -1'),'wheel 未按 ±1 调节');
assert(s.includes("{ passive: false }"),'wheel 未阻止页面滚动');
assert(s.includes('data-act="exp-frames" min="1" max="300" step="1"'),'滑块范围/步长错误');
console.log('diff_panel_eval_wheel PASS (固定帧数输入框 + 滚轮±1)');
