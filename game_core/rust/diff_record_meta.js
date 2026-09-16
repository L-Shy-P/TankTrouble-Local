#!/usr/bin/env node
// v113 regression: recording metadata must self-report the real tree version and the
// experiment switches, and index.html / testbench version strings must not drift.
'use strict';
const fs=require('fs'),path=require('path'),vm=require('vm');
const root=path.resolve(__dirname,'..');
const Constants={BULLET:{RADIUS:{m:0.25},OFFSET:{m:2.5},TURRET:{WIDTH:{m:0.7},HEIGHT:{m:1.4},OFFSET_X:{m:0},OFFSET_Y:{m:-2}}},TANK:{WIDTH:{m:3},HEIGHT:{m:4}},BULLET_TURRET:{WIDTH:{m:0.7},HEIGHT:{m:1.4},OFFSET_X:{m:0},OFFSET_Y:{m:-2}},LASER_TURRET:{ANTENNA_WIDTH:{m:0.1},ANTENNA_HEIGHT:{m:1.4},ANTENNA_OFFSET_X:{m:0},ANTENNA_OFFSET_Y:{m:-2},DISH_WIDTH:{m:2},DISH_HEIGHT:{m:0.5},DISH_OFFSET_X:{m:0},DISH_OFFSET_Y:{m:-1.85}},DOUBLE_BARREL_TURRET:{WIDTH:{m:1.6},HEIGHT:{m:1.1},OFFSET_X:{m:0},OFFSET_Y:{m:-1.75}},SHOTGUN_TURRET:{WIDTH:{m:1.4},HEIGHT:{m:1.35},OFFSET_X:{m:0},OFFSET_Y:{m:-1.95}},MISSILE_TURRET:{WIDTH:{m:0.3},CENTER_HEIGHT:{m:1.4},SIDE_HEIGHT:{m:0.4},OFFSET_X:{m:0},OFFSET_Y:{m:-1.95}},GATLING_GUN_TURRET:{WIDTH:{m:1.4},HEIGHT:{m:1.35},OFFSET_X:{m:0},OFFSET_Y:{m:-1.95}},MAZE_TILE_SIZE:{m:10},PIXELS_PER_METER:20};
const sandbox={console,performance,Math,JSON,Array,Object,String,Number,isFinite,parseInt,parseFloat,Infinity,NaN,Date,Constants};
sandbox.global=sandbox;
const ctx=vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(root,'js','vantage_scoring.js'),'utf8'),ctx,{filename:'s.js'});
vm.runInContext(fs.readFileSync(path.join(root,'js','vantage_tree.js'),'utf8'),ctx,{filename:'t.js'});
const VT=sandbox.VantageTree;
function fail(msg){ throw new Error(msg); }

// ① 树自己报的版本号
if(typeof VT.VERSION!=='string'||!/^v\d+$/.test(VT.VERSION)) fail('树没有自报版本号: '+VT.VERSION);
const treeNum=parseInt(VT.VERSION.slice(1),10);

// ② index.html 的 ?v= 必须和树版本一致（版本漂移的根本原因就是这里没人对账）
const html=fs.readFileSync(path.join(root,'index.html'),'utf8');
const mTree=/js\/vantage_tree\.js\?v=(\d+)/.exec(html);
const mTb=/js\/vantage_testbench\.js\?v=(\d+)/.exec(html);
if(!mTree) fail('index.html 里找不到 vantage_tree.js 的 ?v=');
if(Number(mTree[1])!==treeNum) fail('index.html 树版本 ?v='+mTree[1]+' 与树自报 '+VT.VERSION+' 不一致');
if(!mTb) fail('index.html 里找不到 vantage_testbench.js 的 ?v=');

// ③ 录制元数据必须带实验开关，且实时反映当前设置
VT.setOcclusionEnabled(true);
VT.setSafeFilterK(0.4);
VT.setActionCostPerFrame(3);
VT.setKfScaleWithK(true);
VT.startRecord('diff_record_meta');
const rec=VT.exportRecord();
VT.stopRecord();
if(rec.meta.treeVersion!==VT.VERSION) fail('录制元数据版本号 '+rec.meta.treeVersion+' != '+VT.VERSION);
if(rec.meta.occlusionEnabled!==true) fail('录制元数据没记遮蔽开关');
if(rec.meta.safeFilterK!==0.4) fail('录制元数据没记安全过滤 k: '+rec.meta.safeFilterK);
if(rec.meta.actionCostPerFrame!==3) fail('录制元数据没记动作成本: '+rec.meta.actionCostPerFrame);
if(rec.meta.kfScaleWithK!==true) fail('录制元数据没记杀戮场等比调整');
// 改一个开关，元数据必须跟着变（防止又写成常量）
VT.setSafeFilterK(0.7); VT.setActionCostPerFrame(0);
const rec2=VT.exportRecord();
if(rec2.meta.safeFilterK!==0.7||rec2.meta.actionCostPerFrame!==0) fail('录制元数据的开关没跟着设置走');
// 恢复默认，别把实验设置漏给别的套件
VT.setSafeFilterK(1); VT.setActionCostPerFrame(0); VT.setOcclusionEnabled(true); VT.setKfScaleWithK(true);
console.log('diff_record_meta OK: '+VT.VERSION+' / index.html ?v='+mTree[1]+' / 录制元数据含四个实验开关');
