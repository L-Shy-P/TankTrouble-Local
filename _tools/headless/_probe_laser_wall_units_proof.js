#!/usr/bin/env node
/* ============================================================================
 * 1-2③-N3 单位证明：`rolloutBatch` 的 bullets[].vx/vy 是**速度(m/s)**，
 * 而 `_probe_laser_wall_cases.js` 的 N3 传的是**每帧位移**(p1-p0)。
 * 本探针用正确单位 (p1-p0)/dt 重跑同一墙/同一几何：
 *   N3（反射后命中）→ dead=true/fd=0；N2（墙挡住）→ dead=false。
 * 对旧 wasm（无“意图段”补丁）与当前 wasm 都 PASS ⟹ N3 产品代码没坏，
 * 是验收探针的单位写法问题。
 * 用法：node _tools/headless/_probe_laser_wall_units_proof.js [wasmPath]
 * ============================================================================ */
'use strict';
const fs=require('fs'),path=require('path'),vm=require('vm');
const root=path.resolve(__dirname,'..','..');
const bridgePath=path.join(root,'game_core','js','vantage_rust_bridge.js');
const wasmPath=process.argv[2]||path.join(root,'game_core','js','wasm','vantage_core.wasm');
const WALL=[{verts:[{x:-2,y:-0.1},{x:6,y:-0.1},{x:6,y:0.1},{x:-2,y:0.1}]}];
(async()=>{
  const sb={console:console}; sb.global=sb; const ctx=vm.createContext(sb);
  sb.WebAssembly=WebAssembly;
  sb.fetch=async()=>({ok:true,arrayBuffer:async()=>{const b=fs.readFileSync(wasmPath);return b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength);}});
  vm.runInContext(fs.readFileSync(bridgePath,'utf8'),ctx);
  const br=sb.VantageRustBridge; const init=await br.init('js/wasm/vantage_core.wasm');
  console.log('wasm='+wasmPath+' md5ish init='+JSON.stringify(init)+' ABI='+br.version());
  const dt=0.02, p0={x:1.5,y:0.5};
  const v={x:(2.545584412271571)/dt, y:(-2.545584412271571)/dt}; // (p1-p0)/dt, |v|=180
  for(const [name,C,expect] of [['N3_same_frame_reflect',{x:4,y:2},true],['N2_wall_blocks',{x:4,y:-2},false]]){
    const r=br.rolloutBatch({startPose:{x:C.x,y:C.y,rot:0},ops:[{speed:0,rotationSpeed:0}],walls:WALL,
      bullets:[{x:p0.x,y:p0.y,vx:v.x,vy:v.y,radius:0,lifeLeft:0.8,active:true,isLaser:true}],frames:3,cacheId:9300+(expect?1:0)});
    const dead=r&&r.ok&&r.dead[0]===true, fd=r&&r.ok?r.deathFrame[0]:null;
    console.log((dead===expect&&(expect?fd===0:!dead)?'PASS':'FAIL')+' '+name+' dead='+dead+' fd='+fd+' expect='+expect+(r&&!r.ok?' err='+r.error:''));
  }
})().catch(e=>{console.error('ERR',(e&&e.stack)||e);process.exitCode=1;});
