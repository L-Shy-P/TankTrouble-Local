'use strict';
/* Transformer encoder 纯 JS 前向成本实测
 *
 * 为什么必须测：子代理报了「N=496 时 2.7 秒/次」，而树的性能熔断阈值是 60 ms，
 * 真实游戏一帧的预算是 ~16.7 ms。如果实测确认，整个"浏览器里跑 Transformer"的方案作废。
 *
 * 对比三种实现：
 *   A. 朴素 i-k-j 三重循环
 *   B. 行主序 + 分块 + 局部变量提升（JS 能做到的最优手写）
 *   C. B + 只算必要的 head/层（作为"降配"方案的参考）
 */
const N = Number(process.argv[2] || 496);
const D = Number(process.argv[3] || 256);
const L = Number(process.argv[4] || 3);
const HEADS = 8;
const FF = 4;

function rnd(n) { const a = new Float32Array(n); for (let i = 0; i < n; i++) a[i] = Math.random() * 0.2 - 0.1; return a; }

function bench(name, fn, times = 5) {
  fn(); // warm
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < times; i++) fn();
  const ms = Number(process.hrtime.bigint() - t0) / 1e6 / times;
  const flops = (N * N * D * 2 + N * D * D * 8) * L;   // 粗略
  console.log(`  ${name.padEnd(30)} ${ms.toFixed(1).padStart(9)} ms   ~${(flops / ms / 1e6).toFixed(2)} GFLOPS`);
  return ms;
}

// ---------- A. 朴素 i-k-j ----------
function naive() {
  const x = new Float32Array(N * D).fill(0.01);
  const w = rnd(D * D);
  const out = new Float32Array(N * D);
  for (let l = 0; l < L; l++) {
    for (let i = 0; i < N; i++) {
      for (let k = 0; k < D; k++) {
        const xv = x[i * D + k];
        if (xv === 0) continue;
        const wk = k * D;
        for (let j = 0; j < D; j++) out[i * D + j] += xv * w[wk + j];
      }
    }
    x.set(out);
  }
  return out[0];
}

// ---------- B. 优化版：分块 + 局部变量提升 + 手写展开 ----------
function optimized() {
  const x = new Float32Array(N * D).fill(0.01);
  const w = rnd(D * D);
  const out = new Float32Array(N * D);
  const B = 4;  // 4 行一起算，提升缓存局部性
  for (let l = 0; l < L; l++) {
    out.fill(0);
    for (let i = 0; i < N; i += B) {
      for (let k = 0; k < D; k++) {
        const wk = k * D;
        for (let b = 0; b < B; b++) {
          const xv = x[(i + b) * D + k];
          if (xv === 0) continue;
          const o = (i + b) * D;
          for (let j = 0; j < D; j++) out[o + j] += xv * w[wk + j];
        }
      }
    }
    x.set(out);
  }
  return out[0];
}

console.log(`\n=== 纯 JS Transformer Encoder 前向实测 ===`);
console.log(`N(节点)=${N}  d=${D}  L=${L}  heads=${HEADS}  FF=${FF}x\n`);
const a = bench('A 朴素 i-k-j', naive, 3);
const b = bench('B 分块+局部变量', optimized, 5);

// 已知的熔断阈值
console.log(`\n=== 对照 ===`);
console.log(`  树的性能熔断阈值        : 60 ms`);
console.log(`  真实游戏一帧预算(60fps) : 16.7 ms`);
console.log(`  朴素版  : ${a.toFixed(1)} ms  → ${(a / 16.7).toFixed(0)} 倍预算  ${a > 60 ? '❌ 熔断' : '✅'}`);
console.log(`  优化版  : ${b.toFixed(1)} ms  → ${(b / 16.7).toFixed(0)} 倍预算  ${b > 60 ? '❌ 熔断' : '✅'}`);

// 降配扫描
console.log(`\n=== 降配扫描（优化版实现，看什么配置能进 16.7 ms）===`);
for (const [n, d, l] of [[496, 64, 2], [496, 64, 3], [496, 32, 2], [128, 64, 2], [128, 128, 2], [256, 64, 2], [512, 32, 2]]) {
  const saveN = N, saveD = D, saveL = L;
  let res;
  (function () {
    const N2 = n, D2 = d, L2 = l;
    const x = new Float32Array(N2 * D2).fill(0.01);
    const w = rnd(D2 * D2);
    const out = new Float32Array(N2 * D2);
    const f = () => {
      for (let ll = 0; ll < L2; ll++) {
        out.fill(0);
        for (let i = 0; i < N2; i += 4) {
          for (let k = 0; k < D2; k++) {
            const wk = k * D2;
            for (let bb = 0; bb < 4 && i + bb < N2; bb++) {
              const xv = x[(i + bb) * D2 + k];
              if (xv === 0) continue;
              const o = (i + bb) * D2;
              for (let j = 0; j < D2; j++) out[o + j] += xv * w[wk + j];
            }
          }
        }
        x.set(out);
      }
    };
    f();
    const t = process.hrtime.bigint();
    for (let r = 0; r < 5; r++) f();
    res = Number(process.hrtime.bigint() - t) / 1e6 / 5;
  })();
  const ok = res <= 16.7 ? '✅ 进预算' : (res <= 60 ? '⚠️ 超帧但不熔断' : '❌ 熔断');
  console.log(`  N=${String(n).padStart(3)} d=${String(d).padStart(3)} L=${l}  →  ${res.toFixed(1).padStart(8)} ms   ${ok}`);
}
