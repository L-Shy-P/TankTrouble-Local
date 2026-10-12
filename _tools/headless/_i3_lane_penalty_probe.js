#!/usr/bin/env node
'use strict';
/* 1-3 ③ lanePenaltyRatio 静默回退陷阱实测（只读产品代码）
   代码链预期：
     预检 vantage_sandbox.js  `if (typeof cfg.lanePenaltyRatio === 'number' && cfg.lanePenaltyRatio > 0) return null;`
       —— cfg={} 时 raw 值是 undefined，预检放行；
     真正下发 lanePenaltyRatio = cfg.lanePenaltyRatio ?? VantageScoring.DEFAULTS.lanePenaltyRatio(=0.5)；
     Rust score_paths.rs `if input.cfg.lane_penalty_ratio > 0.0 { return Err(...) }`
     → bridge 返回 {ok:false} → sandbox console.warn + return null → 上层（树）回退 JS scorePaths。
   本探针记录：送给 Rust 的实际值、bridge 返回、是否静默回退、warn 文本。 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const H = require('../../game_core/rust/_diff_proj_semantics_harness.js');
function staticOps() { const a = []; for (let i = 0; i < 9; i++) a.push(H.staticOp()); return a; }

(async () => {
  const S = H.loadSandbox();
  // 生产页面里 vantage_scoring.js 与 sandbox 同处一个全局；harness 不加载它，
  // 本探针显式加载（否则 defaults.lanePenaltyRatio 取不到 0.5，陷阱不会触发）。
  vm.runInContext(fs.readFileSync(path.join(H.root, 'js', 'vantage_scoring.js'), 'utf8'), S._ctx, { filename: 'vantage_scoring.js' });
  const VS = S.VantageSandbox;
  await H.initRust(S, 'js/wasm/vantage_core.wasm');
  VS.setRustPhysicsEnabled(true);
  VS.setFrameDtSec(1 / 60);
  const pose = { x: 15, y: 15, rot: 0 };
  const walls = H.extractWallPolygons(S, H.makeMaze(4, 3));
  let ai = 0;

  const warns = [];
  const origWarn = console.warn;
  console.warn = function () { warns.push(Array.prototype.slice.call(arguments).map(String).join(' ')); return origWarn.apply(console, arguments); };

  const DEFAULT_LANE = (S.VantageScoring && S.VantageScoring.DEFAULTS) ? S.VantageScoring.DEFAULTS.lanePenaltyRatio : 'n/a';

  function run(name, cfg) {
    const maze = H.makeMaze(4, 3);
    const tank = H.makeFakeTank(S.Box2D, pose.x, pose.y, pose.rot);
    // 威胁/子弹都不需要：本探针只看 cfg 门
    const gc = H.makeGameController(maze, tank, {});
    const ad = VS.createAdapter(gc, 'i3lane_' + (++ai));
    let sent = null, bridgeOk = null, bridgeErr = null;
    const orig = S.VantageRustBridge.scorePaths;
    S.VantageRustBridge.scorePaths = function (input) {
      sent = { lanePenaltyRatio: input && input.cfg ? input.cfg.lanePenaltyRatio : 'n/a',
               springRopeEnabled: input && input.cfg ? input.cfg.springRopeEnabled : 'n/a',
               occlusionEnabled: input && input.cfg ? input.cfg.occlusionEnabled : 'n/a' };
      const r = orig.call(this, input);
      bridgeOk = r && r.ok; bridgeErr = r && r.error;
      return r;
    };
    const opt = { startPose: pose, threats: [], tGlobal: 0, nowTGlobal: 0, auditPurpose: 'jsConfirm', cfg: cfg };
    let out = null;
    warns.length = 0;
    try { out = ad.simulateTankBatchScored(pose, staticOps(), 10, opt); } finally { S.VantageRustBridge.scorePaths = orig; }
    origWarn('  [' + name + '] returned=' + (out ? 'batch(' + out.length + ')' : 'null') +
      '  sentToRust=' + JSON.stringify(sent) + '  bridgeOk=' + bridgeOk + '  bridgeErr=' + (bridgeErr || '') +
      '  warn=' + JSON.stringify(warns.slice(0, 2)));
  }

  origWarn('DEFAULTS.lanePenaltyRatio = ' + DEFAULT_LANE);
  run('cfg={}                ', {});
  run('cfg={occlusionEnabled:false}', { occlusionEnabled: false });
  run('cfg={lanePenaltyRatio:0,deathPenalty:0}', { lanePenaltyRatio: 0, deathPenalty: 0 });

  // Rust 直接拒收 0.5：用 bridge 同款 inputs（空 threats/1 bullet=无）构造最小调用
  let direct = null;
  try {
    direct = S.VantageRustBridge.scorePaths({
      cacheId: 777001, startPose: pose, startT: 0,
      ops: staticOps().map(() => ({ speed: 0, rotationSpeed: 0, moving: false })),
      walls: walls, bullets: [], frames: 3, threats: [],
      cfg: { deathPenalty: 0, stuckPenalty: 4, stuckDistEps: 0.05, stuckRotEps: 0.05,
             lanePenaltyRatio: 0.5, springRopeEnabled: false, occlusionEnabled: true }
    });
  } catch (e) { direct = { threw: String(e && e.message || e) }; }
  origWarn('Rust direct lanePenaltyRatio=0.5 → ' + JSON.stringify(direct));
})().catch(e => { console.error('FATAL', (e && e.stack) || e); process.exitCode = 1; });
