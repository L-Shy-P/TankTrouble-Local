#!/usr/bin/env node
// v160 回归：帧步长必须由 JS 同步进 Rust，Rust 不得再写死 0.02。
// 背景：写死 0.02 导致 rustFrameDtCompatible() 在帧长校准后停用 Rust 快路，
// 实测 1800 帧里只有 44% 时间 Rust 在跑，出问题那局只有 1%。
'use strict';
const fs=require('fs'),path=require('path'),assert=require('assert');
const root=path.resolve(__dirname,'..');
const roll=fs.readFileSync(path.join(root,'rust','vantage_core','src','rollout.rs'),'utf8');
const res=fs.readFileSync(path.join(root,'rust','vantage_core','src','rescore.rs'),'utf8');
const lib=fs.readFileSync(path.join(root,'rust','vantage_core','src','lib.rs'),'utf8');
const sb=fs.readFileSync(path.join(root,'js','vantage_sandbox.js'),'utf8');
const br=fs.readFileSync(path.join(root,'js','vantage_rust_bridge.js'),'utf8');

// 只看代码行；注释里的「旧行为备份」不算违规
function codeOnly(src){
  return src.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
}
const rollCode=codeOnly(roll), resCode=codeOnly(res);

// ① Rust 侧：可设 + 运行时读全局，不再写死
assert(/pub fn set_frame_dt\(v: f64\)/.test(rollCode),'rollout.rs 缺 set_frame_dt');
assert(/pub fn frame_dt\(\) -> f64/.test(rollCode),'rollout.rs 缺 frame_dt()');
assert(!/pub const FRAME_DT: f64/.test(rollCode),'rollout.rs 不得再有写死的 FRAME_DT（注释备份允许）');
assert(!/pub const RESCORE_DT: f64 = 0\.02;/.test(resCode),'rescore.rs 不得再写死 0.02');
const resRuntime=resCode.split(String.fromCharCode(10)).filter(function(l){return !/^pub const RESCORE_DT/.test(l);}).join(String.fromCharCode(10));
assert(resRuntime.indexOf("RESCORE_DT") < 0,"rescore.rs 运行时不得再用裸 RESCORE_DT");

// ② ABI：必须导出 setter，且版本号已升
assert(/pub extern "C" fn vt_set_frame_dt/.test(lib),'lib.rs 缺 vt_set_frame_dt');
assert(/pub extern "C" fn vt_set_frame_dt\(dt: f64\)/.test(lib),'vt_set_frame_dt 签名不对');

// ③ JS 侧：必须在每次 Rust 调用前同步真实帧长
assert(/setFrameDt\s*:\s*function/.test(br),'bridge 缺 setFrameDt');
assert(/vt_set_frame_dt/.test(br),'bridge 必须调用 vt_set_frame_dt');
assert(/setFrameDt\(_frameDtSec\)/.test(sb),'sandbox 必须在 Rust 调用前同步');
// 护栏：不再要求精确 0.02（旧行为保留为回退分支，供旧 wasm 用）
assert(/不再要求精确 == 0\.02/.test(sb),'护栏必须说明已放宽');
assert(/Math\.abs\(_frameDtSec - 0\.02\) < 1e-9/.test(sb),'旧 wasm 的回退分支必须保留');

// ④ 值域护栏（Rust 侧钳 0.005~0.2，越界忽略）
assert(/0\.005\.\.=0\.2\)\.contains\(&v\)/.test(rollCode),'Rust 必须钳帧长值域');

console.log('diff_rust_frame_dt_sync PASS (Rust 可设帧长 + JS 每批同步 + 护栏保留回退)');
