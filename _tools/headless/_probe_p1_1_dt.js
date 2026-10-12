'use strict';
/* 阶段1-1 时间基准探针（施工子代理自用；只读 game_core，不改它）
 *
 *   node _tools/headless/_probe_p1_1_dt.js --case nobullet|laika|fpsdrop|trainstep --tag before|after
 *
 * 作用：
 *   ① 读每帧的 FRAME_DT（VantageTree.exportRecord().meta.frameDt，现取）
 *   ② 读沙箱步长（VantageSandbox.getFrameDtSec()）—— 应由 calibrateFrameDt 同步
 *   ③ 读本帧虚拟时钟步长（__vt.dt）—— 游戏物理真正用的 dt
 *   ④ 读 vantage_1 的树决策（op / commitNode / nodeCount / bulletErr）
 *
 * 场景：
 *   nobullet : 只有 vantage_1、没有对手 ⇒ 全场没有子弹（验证"场上没弹也校准"）
 *   laika    : vantage_1 vs Laika（有子弹）
 *   fpsdrop  : 先 60fps → 30fps → 20fps → 回 60fps（验证"掉帧及时矫正" + 去掉 0.03 钳位）
 *   trainstep: 人工注入 RoundModel._ttStepCount/_ttLastStepDt（验证训练模式精确步数表优先于墙钟）
 *
 * ⚠️ 探针为了跑树，把 VantageTestbench 的 AI 操控切到「树」模式（等价于面板上点一下）。
 *    这只影响本探针进程；不改任何文件。
 */
const fs = require('fs');
const path = require('path');
const { Match } = require('./match');

const SAMPLE = `(() => {
  var out = {};
  try {
    var gc = GameManager.getGameController();
    if (!gc) return { noGc: true };
    out.vtT = Math.round(window.__vt.t * 1000) / 1000;
    out.vtDt = window.__vt.dt;
    out.sbDt = null;
    try {
      if (typeof VantageSandbox !== 'undefined') {
        if (VantageSandbox.getFrameDtSec) out.sbDt = VantageSandbox.getFrameDtSec();
        else if (VantageSandbox.createAdapter) {
          // 兼容：模块级没导出 getFrameDtSec 时，借一个只读 adapter 读同一个模块变量
          var adRead = VantageSandbox.createAdapter(gc, 'probe_reader');
          out.sbDt = adRead.getFrameDtSec ? adRead.getFrameDtSec() : null;
        }
      }
    } catch (eSb) { out.sbErr = String(eSb); }
    out.frameDt = null;
    out.dtMeasured = null; out.dtLastAdv = null; out.dtSwitches = null;
    try {
      var er = VantageTree.exportRecord();
      if (er && er.meta) {
        out.frameDt = er.meta.frameDt;
        out.dtMeasured = er.meta.frameDtMeasured;
        out.dtLastAdv = er.meta.frameDtLastAdv;
        out.dtSwitches = er.meta.frameDtSwitches;
      }
    } catch (eFd) { out.frameDtErr = String(eFd); }
    out.luType = typeof gc.lastUpdate;
    out.luGetTime = !!(gc.lastUpdate && typeof gc.lastUpdate.getTime === 'function');
    var rm = gc.roundController && gc.roundController.model;
    out.stepCount = (rm && typeof rm._ttStepCount === 'number') ? rm._ttStepCount : null;
    out.stepDt = (rm && typeof rm._ttLastStepDt === 'number') ? rm._ttLastStepDt : null;
    out.rngIdx = (window.__vtRng && window.__vtRng.state) ? window.__vtRng.state().idx : null;
    out.rngOverflow = (window.__vtRng && window.__vtRng.state) ? window.__vtRng.state().overflow : null;
    out.state = gc.getState ? gc.getState() : null;
    var tank = gc.getTank('vantage_1');
    out.tank = tank ? { x: +(tank.getX()).toFixed(4), y: +(tank.getY()).toFixed(4),
                        rot: +(tank.getRotation()).toFixed(6) } : null;
    var raw = gc.getRoundState(); var d = __vtData(raw) || {};
    out.nProj = (d.projectileStates || []).length;
    out.op = null; out.commit = null; out.nodes = null; out.bulletErr = null;
    try {
      var tr = VantageTree.getTree();
      if (tr) {
        out.nodes = tr.nodeCount;
        out.bulletErr = (tr.diag && typeof tr.diag.lastBulletError === 'number')
          ? +(tr.diag.lastBulletError.toFixed(4)) : null;
        var cmt = tr.commitNode;
        if (cmt) out.commit = { id: cmt.id, op: cmt.opName, seg: cmt.segmentFrames,
          tEnd: +((cmt.tEndSec || 0)).toFixed(4), st: cmt.status, fd: cmt.fullDeathFrame };
      }
      var de = VantageTree.getDesiredOperation();
      out.op = de ? de.opName : null;
    } catch (eTree) { out.treeErr = String(eTree); }
    return out;
  } catch (e) { return { err: String(e) }; }
})()`;

const CASES = {
  nobullet: { aiCount: 0, schedule: [{ phase: 'nobullet60', dt: 1000 / 60, n: 120 }] },
  laika:    { aiCount: 1, schedule: [{ phase: 'laika60', dt: 1000 / 60, n: 200 }] },
  fpsdrop:  { aiCount: 1, schedule: [
    { phase: '60fps', dt: 1000 / 60, n: 40 },
    { phase: '30fps', dt: 1000 / 30, n: 30 },
    { phase: '20fps', dt: 1000 / 20, n: 30 },
    { phase: 'back60', dt: 1000 / 60, n: 30 },
  ] },
  trainstep: { aiCount: 1, schedule: [
    { phase: 'step40ms', stepDt: 0.04, n: 40 },
    { phase: 'step20ms', stepDt: 0.02, n: 40 },
  ] },
};

function fmt(v) { return (v === null || v === undefined) ? '-' : (Math.round(v * 1e5) / 1e5); }

(async () => {
  const argv = process.argv.slice(2);
  const str = (n, d) => { const i = argv.indexOf('--' + n); return i < 0 ? d : argv[i + 1]; };
  const caseName = str('case', 'laika');
  const tag = str('tag', 'x');
  const cfg = CASES[caseName];
  if (!cfg) throw new Error('未知 case: ' + caseName + '（可用：' + Object.keys(CASES).join('/') + '）');
  const outFile = str('out', path.join(__dirname, 'prof', '_p1_1_dt_' + caseName + '_' + tag + '.jsonl'));
  const rngseqFile = str('rngseq', null);       // 回放同一条 Math.random 序列（同地图/同世界）
  const dumpRngFile = str('dump-rng', null);    // 把本次消耗的随机序列存下来
  const calibOff = argv.indexOf('--calib-off') >= 0;   // 关校准=冻结 FRAME_DT 0.02（旧行为代理）

  const m = new Match();
  const rows = [];
  const openOpts = { humanIds: ['tank_a'], aiCount: cfg.aiCount, vantCount: 1, rng: rngseqFile ? 'play' : 'record' };
  if (rngseqFile) openOpts.rngSeq = JSON.parse(fs.readFileSync(rngseqFile, 'utf8')).seq;
  await m.open(openOpts);
  if (calibOff) {
    const c0 = await m.eval('VantageTree.setFrameDtCalibrationEnabled(false)');
    console.log('校准已关（冻结 FRAME_DT=0.02）→ ' + c0);
  }
  if (argv.indexOf('--numeric-lastupdate') >= 0) {
    // 探针：把 gc.lastUpdate 在每帧 tick 前转成 number，激活 resolveWorldDt 里
    // `typeof gc.lastUpdate === 'number'` 那条【现在因 lastUpdate 是 Date 而失效】的墙钟回退。
    const nHooks = await m.eval('(() => { window.__vtBefore.push(function(){' +
      ' var gc = GameManager.getGameController();' +
      ' if (gc && gc.lastUpdate && typeof gc.lastUpdate.getTime === "function") gc.lastUpdate = gc.lastUpdate.getTime();' +
      ' }); return window.__vtBefore.length; })()');
    console.log('已挂 __vtBefore 把 lastUpdate 转 number（激活 resolveWorldDt 墙钟回退）hooks=' + nHooks);
  }
  const ctl = await m.eval(
    '(() => { var st = VantageTestbench.getState(); st.aiControl.enabled = true; st.aiControl.tree = true;' +
    ' return { enabled: st.aiControl.enabled, tree: st.aiControl.tree }; })()');

  let f = 0;
  for (const seg of cfg.schedule) {
    if (typeof seg.dt === 'number') await m.eval('window.__vt.dt = ' + seg.dt + '; 1');
    for (let i = 0; i < seg.n; i++) {
      if (typeof seg.stepDt === 'number') {
        // trainstep：人工扮演 training_mode 的步长表（每帧一步）
        await m.eval('(() => { var rm = GameManager.getGameController().roundController.model;' +
          ' rm._ttStepCount = ' + (f + 1) + '; rm._ttLastStepDt = ' + seg.stepDt + '; return rm._ttStepCount; })()');
      }
      await m.pump(1);
      f++;
      const s = await m.eval(SAMPLE);
      rows.push(Object.assign({ f: f, phase: seg.phase, phaseDt: (seg.stepDt || seg.dt || null) }, s));
    }
  }

  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');

  console.log('case=' + caseName + ' tag=' + tag + ' 树模式=' + JSON.stringify(ctl) +
    ' 帧数=' + rows.length + ' → ' + outFile);
  console.log('lastUpdateType=' + rows[0].luType + ' getTime=' + rows[0].luGetTime +
    ' ttStep=' + rows[0].stepCount);
  const phases = [];
  for (const r of rows) if (phases.indexOf(r.phase) < 0) phases.push(r.phase);
  for (const ph of phases) {
    const rs = rows.filter((r) => r.phase === ph);
    const target = rs[0].phaseDt;
    let firstNear = null;
    for (const r of rs) {
      if (typeof r.frameDt === 'number' && Math.abs(r.frameDt - target) <= 0.02 * target) { firstNear = r.f; break; }
    }
    const fds = rs.map((r) => fmt(r.frameDt)).join(',');
    const last = rs[rs.length - 1];
    console.log('  [' + ph + '] target=' + fmt(target) + ' 首个贴合帧=' + (firstNear === null ? '未贴合' : firstNear) +
      ' FRAME_DT轨迹=' + fds);
    console.log('      末帧: FRAME_DT=' + fmt(last.frameDt) + ' 沙箱=' + fmt(last.sbDt) +
      ' 实测=' + fmt(last.dtMeasured) + ' 矫正次数=' + last.dtSwitches +
      ' nProj=' + last.nProj + ' op=' + last.op + ' nodes=' + last.nodes + ' bulletErr=' + fmt(last.bulletErr));
  }
  if (dumpRngFile) {
    const seq = await m.eval('window.__vtRng.dump()');
    const st = await m.eval('window.__vtRng.state()');
    fs.writeFileSync(dumpRngFile, JSON.stringify({ seq: seq, state: st }));
    console.log('rng 已存 ' + dumpRngFile + ' len=' + (seq ? seq.length : 0) + ' state=' + JSON.stringify(st));
  }
  await m.close();
})().catch((e) => { console.error('PROBE FAILED: ' + ((e && e.stack) || e)); process.exitCode = 1; });
