#!/usr/bin/env node
// v162 回归：破片撞墙即停（复刻 Shrapnel.hitMaze 的速度清零），融合世界不得让它反弹。
// 实证：录制 vantage_record_1790925717252.json 地雷致死时
//   placements=30/36/72、contacts=[]、dfs=[-1]、killer polyGap=1.22
//   —— 破片在融合世界里该停的地方弹走了，擦过 1.22 米 → 树全绿 → 死。
'use strict';
const fs=require('fs'),path=require('path'),assert=require('assert');
const root=path.resolve(__dirname,'..');
const sb=fs.readFileSync(path.join(root,'js','vantage_sandbox.js'),'utf8');

// ① 必须标记破片
assert(sb.includes('slot.isShrapnel'),'摆弹时必须标记破片');
// v164：改由弹种档案判定；且 approx 分支也必须落标记（原来 continue 掉公共收尾）。
assert(/slot\.isShrapnel = !!\(slotProf && slotProf\.name === 'MINE_SHRAPNEL'\)/.test(sb),'破片必须按弹种档案判定');
assert(/slot\.isShrapnel = !!\(slotProfA && slotProfA\.name === 'MINE_SHRAPNEL'\)/.test(sb),'approx 分支也必须落破片标记');
assert(sb.indexOf('slot.prevDirX = null; slot.prevDirY = null;', sb.indexOf("src: 'approx'")) > 0
    || /slotProfA[\s\S]{0,400}slot\.prevDirX = null/.test(sb),'approx 分支必须重置 prevDir');

// ② 必须做方向变化的检测（反弹 = 方向变）
assert(sb.includes('bs.prevDirX'),'必须记上一帧方向');
assert(/dot < 0\.999/.test(sb),'必须用方向点积判反弹');
assert(/SetLinearVelocity\(Box2D\.Common\.Math\.b2Vec2\.Make\(0, 0\)\)/.test(sb.slice(sb.indexOf('bs.isShrapnel && bs.prevDirX'))),
       '撞墙后必须把速度清零');

// ③ 只对破片生效，不能误伤会反弹的弹种
const idx=sb.indexOf('bs.isShrapnel && bs.prevDirX');
const blk=sb.slice(idx, idx+700);
assert(blk.includes('bs.active = false'),'撞墙后必须停用该破片');
assert(!/SHOTGUN|GATLING|DOUBLE_BARREL/.test(blk),'反弹弹种不得被这条影响');

// ④ 依据写进注释（以后好查）
assert(sb.includes('Shrapnel.hitMaze'),'注释必须写明依据');
assert(sb.includes('polyGap=1.22'),'注释必须写明实证数据');

// ⑤ 地雷破片不反弹这条语义，和 §9.6 语义表一致
const doc=fs.readFileSync(path.join(root,'..','docs','Vantage躲弹实现','03-踩坑与待查','待查与审计','待查清单-不确定项与判别方法.md'),'utf8');
assert(doc.includes('9.6 各弹种物理语义总表'),'文档必须有弹种语义表');
assert(/MINE\(破片\)[\s\S]{0,80}速度清零/.test(doc),'语义表必须写明破片速度清零');
// ⑥ v9：破片标记必须从 JS 一路透传到 Rust，且 Rust 判据与 JS 同口径。
//    只测 JS 文本不够——上一版就是「JS 对、Rust 错」导致树按假绿选路。
const LF = String.fromCharCode(10);
const bridgeSrc = fs.readFileSync(path.join(root, 'js', 'vantage_rust_bridge.js'), 'utf8');
assert(bridgeSrc.split('bulletIsShrapnelBase, bulletCount,').length - 1 >= 2,
       'vt_rollout_batch / vt_score_paths 两个弹体 ABI 入口都要传 bullet_is_shrapnel');
assert(bridgeSrc.indexOf('wasm/vantage_core.wasm?v=14') >= 0, 'wasm 缓存戳必须与 bridge 实际值一致');
assert(sb.split('isShrapnel: !!slot.isShrapnel').length - 1 === 2,
       'simulateRustBatch / simulateTankBatchScored 两个 Rust 入口都要填 isShrapnel');

const libSrc = fs.readFileSync(path.join(root, 'rust', 'vantage_core', 'src', 'lib.rs'), 'utf8');
const vIdx = libSrc.indexOf('fn vt_version() -> u32 {');
assert(vIdx >= 0, 'lib.rs 必须有 vt_version');
assert(libSrc.slice(vIdx, vIdx + 1200).indexOf(LF + '    9') >= 0, 'vt_version 必须升到 9');

const rolloutSrc = fs.readFileSync(path.join(root, 'rust', 'vantage_core', 'src', 'rollout.rs'), 'utf8');
assert(rolloutSrc.indexOf('pub is_shrapnel: bool') >= 0, 'Rust BulletInput 必须有 is_shrapnel');
assert(rolloutSrc.indexOf('slot.is_shrapnel && slot.has_prev_dir') >= 0, 'Rust 必须有破片上一帧方向检测');
assert(rolloutSrc.indexOf('dot < 0.999') >= 0, 'Rust 必须与 JS 同判据 dot < 0.999');
assert(rolloutSrc.indexOf('len_sq <= 0.01') >= 0, 'Rust 必须有 Shrapnel.done 的速度²判据');
assert(rolloutSrc.indexOf('Shrapnel.hitMaze') >= 0, 'Rust 注释必须写明依据 Shrapnel.hitMaze');

console.log('diff_shrapnel_wall_stop PASS (破片撞墙清零停止，反弹弹种不受影响；v10 已透传 Rust 且判据一致)');
