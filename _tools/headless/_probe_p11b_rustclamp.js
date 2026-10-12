'use strict';
/* 阶段1-1b 探针（施工子代理自用；只读 game_core，不改它）
 *
 *   node _tools/headless/_probe_p11b_rustclamp.js \
 *        --wasm game_core/js/wasm/vantage_core.wasm --dts 0.04,0.004,0.001,1.0
 *
 * 目的：证明 Rust 侧 `set_frame_dt` 的值域与 JS 侧是否一致。
 *   做法（纯 Node，不开浏览器）：
 *     ① 把 VantageRustBridge 跑在 vm 沙箱里，fetch 读指定的 .wasm 文件
 *     ② 先 setFrameDt(0.05) 归零基准（老/新 wasm 都接受）
 *     ③ 再 setFrameDt(dt)，然后跑一次 10 帧 rolloutBatch（无墙无弹，用坦克位移读帧长）
 *        · Rust 收下了 → 位移 ≈ speed*10*dt
 *        · Rust 静默忽略了 → 位移 ≈ speed*10*0.05（还是上一个值）
 *        （样本数组只有 x/y/rot，没有时间戳；坦克速度是"米/秒"，位移直接反映 Rust 实际用的 dt）
 *   值域旧 = [0.005, 0.2]（240Hz 的 0.00417 会被吞）；新 = [0.001, 1.0]（与 JS 一致）。
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..', '..');

function loadBridge(wasmFile) {
  const sandbox = { console: console };
  sandbox.global = sandbox;
  const ctx = vm.createContext(sandbox);
  sandbox.WebAssembly = WebAssembly;
  sandbox.fetch = async function () {
    const bytes = fs.readFileSync(wasmFile);
    return {
      ok: true,
      arrayBuffer: async function () {
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      },
    };
  };
  vm.runInContext(fs.readFileSync(path.join(root, 'game_core', 'js', 'vantage_rust_bridge.js'), 'utf8'),
    ctx, { filename: 'vantage_rust_bridge.js' });
  return sandbox.VantageRustBridge;
}

(async () => {
  const argv = process.argv.slice(2);
  const str = (n, d) => { const i = argv.indexOf('--' + n); return i < 0 ? d : argv[i + 1]; };
  const wasmFile = path.resolve(str('wasm', path.join(root, 'game_core', 'js', 'wasm', 'vantage_core.wasm')));
  const dts = str('dts', '0.04,0.004,0.001,1.0').split(',').map(Number);
  const FRAMES = 10;

  const bridge = loadBridge(wasmFile);
  const init = await bridge.init('js/wasm/vantage_core.wasm');
  if (!init.ok) throw new Error('bridge init failed: ' + init.error);
  console.log('wasm=' + wasmFile + ' md5=' + require('crypto').createHash('md5').update(fs.readFileSync(wasmFile)).digest('hex') +
    ' abi=' + bridge.version());

  const SPEED = 15.95;           // m/s（rollout.rs 里九操作表的最大速度量级）
  function run(dist) {
    const r = bridge.rolloutBatch({
      cacheId: 0, startPose: { x: 5, y: 8, rot: 0 },
      ops: [{ speed: SPEED, rotationSpeed: 0 }], walls: [], bullets: [], frames: FRAMES,
    });
    const p = r.samples[0][FRAMES];
    return Math.sqrt((p.x - 5) * (p.x - 5) + (p.y - 8) * (p.y - 8));   // 直线位移（米）
  }

  // ① 基准：0.05 s/帧（老/新 wasm 都接受）
  bridge.setFrameDt(0.05);
  const baseDist = run();

  let allOk = true;
  let prevDist = -1;      // 第一行是基准 dt=0.05 本身，不能被判成“沿用上一次的值”
  for (const dt of dts) {
    bridge.setFrameDt(dt);
    const dist = run();
    const ratio = dist / baseDist;
    const linear = Math.abs(ratio - dt / 0.05) < 0.02;   // 位移与帧长成正比（正常 dt 区间）
    const keptPrev = Math.abs(dist - prevDist) < 1e-6;  // 与"上一个被接受的值"完全一样 = 没收下
    const accepted = !keptPrev;
    const inJsRange = (dt >= 0.001 && dt <= 1.0);
    const ok = (inJsRange && accepted) || (!inJsRange && keptPrev);
    allOk = allOk && ok;
    console.log('dt=' + dt + ' → 10帧位移=' + dist.toFixed(4) + 'm  位移比=' + ratio.toFixed(4) +
      '  线性期望=' + (dt / 0.05).toFixed(4) + '(线性=' + linear + ')' +
      '  [' + (accepted ? '收下' : '静默忽略(沿用上一次的值)') + ']' +
      '  JS值域内=' + inJsRange + (ok ? '' : '  ❌'));
    prevDist = dist;
  }
  console.log('基准 dt=0.05 位移=' + baseDist.toFixed(4) + 'm（理论 ' + (SPEED * FRAMES * 0.05).toFixed(4) + 'm）');
  console.log('判定[JS 值域内 Rust 一律收下]: ' + (allOk ? 'PASS' : 'FAIL') +
    '（dt=1.0 时 Box2D 大步长下位移不再线性，属正常）');
  if (!allOk) process.exitCode = 1;
})().catch((e) => { console.error('PROBE FAILED: ' + ((e && e.stack) || e)); process.exitCode = 1; });
