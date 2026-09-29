#!/usr/bin/env node
// v142 回归：低 evalFrames 时段长不能超过实际模拟帧数
'use strict';
const fs=require('fs'),path=require('path'),vm=require('vm'),assert=require('assert');
const root=path.resolve(__dirname,'..');
const Constants={BULLET:{RADIUS:{m:0.25},OFFSET:{m:2.5}},TANK:{WIDTH:{m:3},HEIGHT:{m:4}},BULLET_TURRET:{WIDTH:{m:0.7},HEIGHT:{m:1.4},OFFSET_X:{m:0},OFFSET_Y:{m:-2}},LASER_TURRET:{ANTENNA_WIDTH:{m:0.1},ANTENNA_HEIGHT:{m:1.4},ANTENNA_OFFSET_X:{m:0},ANTENNA_OFFSET_Y:{m:-2},DISH_WIDTH:{m:2},DISH_HEIGHT:{m:0.5},DISH_OFFSET_X:{m:0},DISH_OFFSET_Y:{m:-1.85}},DOUBLE_BARREL_TURRET:{WIDTH:{m:1.6},HEIGHT:{m:1.1},OFFSET_X:{m:0},OFFSET_Y:{m:-1.75}},SHOTGUN_TURRET:{WIDTH:{m:1.4},HEIGHT:{m:1.35},OFFSET_X:{m:0},OFFSET_Y:{m:-1.95}},MISSILE_TURRET:{WIDTH:{m:0.3},CENTER_HEIGHT:{m:1.4},SIDE_HEIGHT:{m:0.4},OFFSET_X:{m:0},OFFSET_Y:{m:-1.95}},GATLING_GUN_TURRET:{WIDTH:{m:1.4},HEIGHT:{m:1.35},OFFSET_X:{m:0},OFFSET_Y:{m:-1.95}},MAZE_TILE_SIZE:{m:10}};
const sb={console,performance,Math,JSON,Array,Object,String,Number,isFinite,parseInt,parseFloat,Infinity,NaN,Date,Constants};sb.global=sb;sb.VantageSandbox={fusedEnabled:()=>true,OPERATIONS:Array.from({length:9},(_,i)=>({name:'op'+i,inputs:{forward:i===1,back:i===2,left:i===3,right:i===4}}))};
const ctx=vm.createContext(sb);vm.runInContext(fs.readFileSync(path.join(root,'js','vantage_scoring.js'),'utf8'),ctx);vm.runInContext(fs.readFileSync(path.join(root,'js','vantage_tree.js'),'utf8'),ctx);const VT=sb.VantageTree;
function results(n){return Array.from({length:9},(_,i)=>({perFrameScores:Array.from({length:n},()=>i===0?1:0),totalScore:i===0?n:0,samples:Array.from({length:n+1},(_,k)=>({x:k,y:0,rot:0})),dead:false,deathFrame:-1}));}
for(const n of [1,2,3,75,300]){const p=VT.probeSegment(results(n),{tMin:1,tMax:30});assert(p.segmentFrames<=n,'evalFrames='+n+' produced segmentFrames='+p.segmentFrames);assert(p.segmentFrames>=1,'evalFrames='+n+' segment must remain >=1');}
assert.strictEqual(VT.VERSION,'v143');
const src=fs.readFileSync(path.join(root,'js','vantage_tree.js'),'utf8');
assert(src.includes('var evalCap = Math.max(1, Math.round(EVAL_FRAMES));'),'effectiveExpandCfg must cap tMin by EVAL_FRAMES');
assert(src.includes('var rawMinFrames = Math.ceil'),'must retain raw min frame calculation');
console.log('diff_tree_low_eval_frames PASS (segmentFrames never exceeds evaluatedFrames)');
