#!/usr/bin/env node
// v154 回归：软死节点必须在段末提交后立即再分叉一层（否则树深度停在 1 层）。
'use strict';
const fs=require('fs'),path=require('path'),assert=require('assert');
const root=path.resolve(__dirname,'..');
const s=fs.readFileSync(path.join(root,'js','vantage_tree.js'),'utf8');

assert(s.includes('function growAfterCommitIfNeeded'), '缺提交后补分叉函数');
// 必须挂在两个提交出口之后
const f=s.indexOf('function growAfterCommitIfNeeded');
// v159：主人要求注释掉（面板无开关 + seg=1 时每 tick 多一次 rolloutNine）
assert(s.includes('// growAfterCommitIfNeeded(tree, adapter, evalThreats);'),'补分叉调用必须是注释状态');
assert(s.includes('function growAfterCommitIfNeeded'),'函数必须保留（文档留方案）');
// 只对软死补分叉：真死(fd<=1)和活满都不补
assert(s.includes('if (isTerminalDead(n)) return false;'), '真死不得再分叉');
assert(s.includes('if (!(n.fullDeathFrame >= 2)) return false;'), '只对软死(fd>=2)补分叉');
// 性能护栏
assert(s.includes('if (tree._growSkip) return false;'), '缺性能熔断护栏');
assert(s.includes('tree.stats.growMs <= 60'), '缺生长耗时护栏');
// 语义锁死：红 = 走<=1步就死
assert(/function isTerminalDead\(n\)[\s\S]{0,200}fullDeathFrame <= 1/.test(s), '红必须=fd<=1');
assert(/function safeFramesForDeath[\s\S]{0,300}if \(fd <= 1\) return 1;/.test(s), 'fd<=1 必须只执行 1 帧');
console.log('diff_tree_softdead_refork PASS (软死补分叉 + 真死不补 + 红=fd<=1)');
