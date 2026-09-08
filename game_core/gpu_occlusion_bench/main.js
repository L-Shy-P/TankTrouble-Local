'use strict';

// ---------------------------------------------------------------------------
// Self-contained JS exact f64 reference (mirrors js/vantage_scoring.js
// copy-area 2 `exactOcclusion` / `occlusionIntervals`).
// ---------------------------------------------------------------------------
const TWO_PI = Math.PI * 2;
const ROT_SHIFT = Math.PI / 2;
const GEO = (() => {
  const bulletR = 5.0 / 20.0;
  const halfW = 60.0 / 20.0 * 0.5;
  const halfBack = 80.0 / 20.0 * 0.5;
  const turretTip = Math.abs(-40.0 / 20.0) + (28.0 / 20.0) * 0.5;
  const muzzle = (50.0 / 20.0) + bulletR;
  const halfForward = Math.max(halfBack, turretTip, muzzle);
  const rectHalfH = (halfForward + halfBack) * 0.5;
  return {
    HALF_W: halfW,
    RECT_HALF_H: rectHalfH,
    EFF_HALF_W: halfW + bulletR,
    EFF_HALF_H: rectHalfH + bulletR,
    R_ABS: halfW + bulletR,
    R_SEMI: Math.sqrt(rectHalfH * rectHalfH + halfW * halfW) + bulletR,
    GEO_OFFSET: (halfForward - halfBack) * 0.5,
  };
})();

function normAngle(a) {
  const T = TWO_PI;
  return ((a % T) + T) % T;
}

function normHalf(a) {
  while (a > Math.PI) a -= TWO_PI;
  while (a < -Math.PI) a += TWO_PI;
  return a;
}

function gapWidth(g) {
  const w = normHalf(g.end - g.start);
  return w < 0 ? w + TWO_PI : w;
}

function mergeIntervals(intervals) {
  if (intervals.length === 0) return [];
  const evts = [];
  for (let i = 0; i < intervals.length; i++) {
    let s = intervals[i].start, e = intervals[i].end;
    while (s < 0) s += TWO_PI;
    while (s >= TWO_PI) s -= TWO_PI;
    while (e < 0) e += TWO_PI;
    while (e >= TWO_PI) e -= TWO_PI;

    if (s <= e) {
      evts.push({ type: 's', a: s }, { type: 'e', a: e });
    } else {
      evts.push({ type: 's', a: 0 }, { type: 'e', a: e });
      evts.push({ type: 's', a: s }, { type: 'e', a: TWO_PI });
    }
  }
  evts.sort((a, b) => a.a - b.a || (a.type === 's' ? -1 : 1));

  const merged = [];
  let depth = 0, curStart = -1;
  for (const ev of evts) {
    if (ev.type === 's') {
      if (depth === 0) curStart = ev.a;
      depth++;
    } else {
      depth--;
      if (depth === 0 && curStart >= 0) {
        merged.push({ start: curStart, end: ev.a });
        curStart = -1;
      }
    }
  }

  if (merged.length >= 2) {
    const first = merged[0], last = merged[merged.length - 1];
    if (Math.abs(first.start) < 0.001 && Math.abs(last.end - TWO_PI) < 0.001) {
      merged[0] = { start: last.start, end: first.end };
      merged.pop();
    }
  }
  return merged;
}

function findGaps(merged) {
  if (merged.length === 0) return [{ start: 0, end: TWO_PI }];
  const gaps = [];
  for (let i = 0; i < merged.length - 1; i++) {
    gaps.push({ start: merged[i].end, end: merged[i + 1].start });
  }
  const first = merged[0], last = merged[merged.length - 1];
  if (first.start > 0.001 || last.end < TWO_PI - 0.001) {
    gaps.push({ start: last.end, end: first.start + TWO_PI });
  }
  return gaps;
}

function testArc(rawArcs, aLo, aHi, bLo, bHi) {
  const lo = Math.max(aLo, bLo);
  const hi = Math.min(aHi, bHi);
  if (lo >= hi - 1e-9) return;
  const nLo = normAngle(lo);
  const nHi = normAngle(hi);
  if (nLo < nHi) {
    rawArcs.push({ start: nLo, end: nHi });
  } else {
    rawArcs.push({ start: nLo, end: TWO_PI });
    rawArcs.push({ start: 0, end: nHi });
  }
}

function exactRawArcs(gx, gy, bullets) {
  const rawArcs = [];
  for (const b of bullets) {
    const dx = b.x - gx, dy = b.y - gy;
    const D = Math.sqrt(dx * dx + dy * dy);
    if (D <= 1e-9) continue;
    const aW = Math.asin(Math.min(1, GEO.EFF_HALF_W / D));
    const aH = Math.asin(Math.min(1, GEO.EFF_HALF_H / D));
    if (aW + aH < Math.PI / 2 - 1e-9) continue;
    if (aW >= Math.PI / 2 - 1e-9) {
      rawArcs.push({ start: 0, end: TWO_PI });
      continue;
    }
    const theta = Math.atan2(dy, dx);
    const sinB = [theta - aW, theta + aW, theta + Math.PI - aW, theta + Math.PI + aW];
    const cosB = [
      theta + Math.PI / 2 - aH,
      theta + Math.PI / 2 + aH,
      theta + 3 * Math.PI / 2 - aH,
      theta + 3 * Math.PI / 2 + aH,
    ];
    for (let sa = 0; sa < 4; sa += 2) {
      for (let sb = 0; sb < 4; sb += 2) {
        testArc(rawArcs, sinB[sa], sinB[sa + 1], cosB[sb], cosB[sb + 1]);
        testArc(rawArcs, sinB[sa] + TWO_PI, sinB[sa + 1] + TWO_PI, cosB[sb], cosB[sb + 1]);
        testArc(rawArcs, sinB[sa], sinB[sa + 1], cosB[sb] - TWO_PI, cosB[sb + 1] - TWO_PI);
      }
    }
  }
  return rawArcs;
}

function scoreFromGaps(gaps) {
  let score = 0;
  for (const g of gaps) {
    const w = gapWidth(g);
    if (w <= 1e-9) continue;
    score += w * w;
  }
  return score;
}

function jsExactScore(pose, bullets) {
  const gx = pose.x + Math.sin(pose.rot) * GEO.GEO_OFFSET;
  const gy = pose.y - Math.cos(pose.rot) * GEO.GEO_OFFSET;
  const absR2 = GEO.R_ABS * GEO.R_ABS;
  const semiR2 = GEO.R_SEMI * GEO.R_SEMI;
  const near = [];
  for (const b of bullets) {
    const dx = b.x - gx, dy = b.y - gy;
    const d2 = dx * dx + dy * dy;
    if (d2 < absR2) return 0;
    if (d2 < semiR2) near.push(b);
  }
  if (near.length === 0) return TWO_PI * TWO_PI;
  const rawArcs = exactRawArcs(gx, gy, near);
  if (rawArcs.length === 0) return TWO_PI * TWO_PI;
  const merged = mergeIntervals(rawArcs);
  const gaps = findGaps(merged);
  return scoreFromGaps(gaps);
}

// ---------------------------------------------------------------------------
// GPU-side score from raw f32 arcs (merging is done on the CPU).
// ---------------------------------------------------------------------------
function gpuScoreFromArcs(rawArcs, fullOcclusionFlag) {
  if (fullOcclusionFlag) return 0;
  if (rawArcs.length === 0) return TWO_PI * TWO_PI;
  const merged = mergeIntervals(rawArcs);
  const gaps = findGaps(merged);
  return scoreFromGaps(gaps);
}

// ---------------------------------------------------------------------------
// Deterministic scene generation.
// ---------------------------------------------------------------------------
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function generateScene(opCount, frameCount, bulletsPerFrame, seed) {
  const rnd = mulberry32(seed);
  const poseCount = opCount * frameCount;
  const poses = [];
  for (let op = 0; op < opCount; op++) {
    let x = 5.0 + (rnd() - 0.5) * 4;
    let y = 8.0 + (rnd() - 0.5) * 4;
    let rot = (rnd() - 0.5) * 2.0;
    for (let f = 0; f < frameCount; f++) {
      x += (rnd() - 0.5) * 0.6;
      y += (rnd() - 0.5) * 0.6;
      rot += (rnd() - 0.5) * 0.2;
      poses.push({ x, y, rot });
    }
  }
  const bullets = [];
  for (let f = 0; f < frameCount; f++) {
    for (let b = 0; b < bulletsPerFrame; b++) {
      bullets.push({
        x: 5.0 + (rnd() - 0.5) * 30.0,
        y: 8.0 + (rnd() - 0.5) * 30.0,
      });
    }
  }
  return { poses, bullets };
}

// ---------------------------------------------------------------------------
// WebGPU runner.
// ---------------------------------------------------------------------------
async function runGpu(poses, bullets, frameCount, bulletsPerFrame) {
  if (!navigator.gpu) {
    throw new Error('此浏览器不支持 WebGPU');
  }
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('requestAdapter 返回 null');
  const device = await adapter.requestDevice();
  if (!device) throw new Error('requestDevice 返回 null');

  const wgslUrl = new URL('occlusion.wgsl', window.location.href).href;
  const resp = await fetch(wgslUrl);
  if (!resp.ok) throw new Error('无法加载 occlusion.wgsl: ' + resp.status);
  const shaderCode = await resp.text();

  // 捕获 shader/管线/提交阶段的校验错误，避免只看到后续
  // mapAsync 的“Invalid Buffer due to a previous error”间接报错。
  device.pushErrorScope('validation');
  let shaderModule;
  try {
    shaderModule = device.createShaderModule({ code: shaderCode });
  } catch (e) {
    const scopeErr = await device.popErrorScope();
    throw new Error('WGSL 编译失败：' + (scopeErr ? scopeErr.message : e.message));
  }

  const poseCount = poses.length;
  const MAX_ARCS_PER_BULLET = 16;
  const maxArcsPerPose = bulletsPerFrame * MAX_ARCS_PER_BULLET;

  // Pack poses into f32 storage.
  const poseData = new Float32Array(poseCount * 3);
  for (let p = 0; p < poseCount; p++) {
    poseData[p * 3] = poses[p].x;
    poseData[p * 3 + 1] = poses[p].y;
    poseData[p * 3 + 2] = poses[p].rot;
  }
  const bulletData = new Float32Array(frameCount * bulletsPerFrame * 2);
  for (let b = 0; b < bullets.length; b++) {
    bulletData[b * 2] = bullets[b].x;
    bulletData[b * 2 + 1] = bullets[b].y;
  }

  const usage = GPUBufferUsage;
  const poseBuffer = device.createBuffer({
    size: poseData.byteLength,
    usage: usage.STORAGE | usage.COPY_DST,
  });
  const bulletBuffer = device.createBuffer({
    size: bulletData.byteLength,
    usage: usage.STORAGE | usage.COPY_DST,
  });
  // WebGPU 规范：带 MAP_READ 的 buffer 只能再带 COPY_DST，不能直接作
  // storage/copy-src。因此计算写进 storage，再用 copyBufferToBuffer
  // 搬到可映射回读 buffer。
  const arcsBuffer = device.createBuffer({
    size: Math.max(4, poseCount * maxArcsPerPose * 2 * 4),
    usage: usage.STORAGE | usage.COPY_DST,
  });
  const arcCountsBuffer = device.createBuffer({
    size: Math.max(4, poseCount * 4),
    usage: usage.STORAGE | usage.COPY_DST,
  });
  const fullOcclusionBuffer = device.createBuffer({
    size: Math.max(4, poseCount * 4),
    usage: usage.STORAGE | usage.COPY_DST,
  });
  const arcsReadbackBuffer = device.createBuffer({
    size: arcsBuffer.size,
    usage: usage.MAP_READ | usage.COPY_DST,
  });
  const arcCountsReadbackBuffer = device.createBuffer({
    size: arcCountsBuffer.size,
    usage: usage.MAP_READ | usage.COPY_DST,
  });
  const fullOcclusionReadbackBuffer = device.createBuffer({
    size: fullOcclusionBuffer.size,
    usage: usage.MAP_READ | usage.COPY_DST,
  });

  device.queue.writeBuffer(poseBuffer, 0, poseData);
  device.queue.writeBuffer(bulletBuffer, 0, bulletData);

  const params = new Float32Array([
    poseCount, frameCount, bulletsPerFrame, maxArcsPerPose,
    TWO_PI, Math.PI, Math.PI / 2,
    GEO.GEO_OFFSET, GEO.R_ABS, GEO.R_SEMI, GEO.EFF_HALF_W, GEO.EFF_HALF_H,
  ]);
  const uniformBuffer = device.createBuffer({
    size: Math.ceil(params.byteLength / 16) * 16,
    usage: usage.UNIFORM | usage.COPY_DST,
  });
  device.queue.writeBuffer(uniformBuffer, 0, params);

  const bindGroupLayout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
    ],
  });
  const bindGroup = device.createBindGroup({
    layout: bindGroupLayout,
    entries: [
      { binding: 0, resource: { buffer: poseBuffer } },
      { binding: 1, resource: { buffer: bulletBuffer } },
      { binding: 2, resource: { buffer: arcsBuffer } },
      { binding: 3, resource: { buffer: arcCountsBuffer } },
      { binding: 4, resource: { buffer: fullOcclusionBuffer } },
      { binding: 5, resource: { buffer: uniformBuffer } },
    ],
  });

  const pipeline = device.createComputePipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] }),
    compute: { module: shaderModule, entryPoint: 'main' },
  });

  const encoder = device.createCommandEncoder();
  const pass = encoder.beginComputePass();
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bindGroup);
  pass.dispatchWorkgroups(Math.ceil(poseCount / 64));
  pass.end();
  encoder.copyBufferToBuffer(arcsBuffer, 0, arcsReadbackBuffer, 0, arcsBuffer.size);
  encoder.copyBufferToBuffer(arcCountsBuffer, 0, arcCountsReadbackBuffer, 0, arcCountsBuffer.size);
  encoder.copyBufferToBuffer(fullOcclusionBuffer, 0, fullOcclusionReadbackBuffer, 0, fullOcclusionBuffer.size);
  device.queue.submit([encoder.finish()]);
  await device.queue.onSubmittedWorkDone();
  const dispatchErr = await device.popErrorScope();
  if (dispatchErr) {
    throw new Error('WebGPU 调度校验失败：' + dispatchErr.message);
  }

  async function mapRead(buffer, Ctor) {
    await buffer.mapAsync(GPUMapMode.READ);
    const copy = new Ctor(buffer.getMappedRange().slice(0));
    buffer.unmap();
    return copy;
  }

  const arcCounts = await mapRead(arcCountsReadbackBuffer, Uint32Array);
  const fullOcclusion = await mapRead(fullOcclusionReadbackBuffer, Uint32Array);
  const arcFloats = await mapRead(arcsReadbackBuffer, Float32Array);

  const gpuScores = new Float64Array(poseCount);
  for (let p = 0; p < poseCount; p++) {
    const count = Math.min(arcCounts[p], maxArcsPerPose);
    const rawArcs = [];
    const base = p * maxArcsPerPose * 2;
    for (let a = 0; a < count; a++) {
      rawArcs.push({
        start: arcFloats[base + a * 2],
        end: arcFloats[base + a * 2 + 1],
      });
    }
    gpuScores[p] = gpuScoreFromArcs(rawArcs, fullOcclusion[p] !== 0);
  }
  return { gpuScores, maxArcsPerPose };
}

// ---------------------------------------------------------------------------
// UI and benchmark driver.
// ---------------------------------------------------------------------------
function formatError(v) {
  return v.toExponential(3);
}

async function runBenchmark() {
  const status = document.getElementById('status');
  const table = document.getElementById('results');
  const detail = document.getElementById('detail');
  status.textContent = '运行中…';
  table.innerHTML = '';
  detail.textContent = '';

  const ops = parseInt(document.getElementById('ops').value, 10) || 9;
  const frames = parseInt(document.getElementById('frames').value, 10) || 75;
  const bulletsPerFrame = parseInt(document.getElementById('bullets').value, 10) || 20;
  const seed = parseInt(document.getElementById('seed').value, 10) || 20260816;
  const poseCount = ops * frames;

  const scene = generateScene(ops, frames, bulletsPerFrame, seed);

  // JS exact f64 reference.
  const jsStart = performance.now();
  const jsScores = new Float64Array(poseCount);
  for (let p = 0; p < poseCount; p++) {
    const frame = p % frames;
    const frameBullets = [];
    const bulletBase = frame * bulletsPerFrame;
    for (let b = 0; b < bulletsPerFrame; b++) {
      frameBullets.push(scene.bullets[bulletBase + b]);
    }
    jsScores[p] = jsExactScore(scene.poses[p], frameBullets);
  }
  const jsMs = performance.now() - jsStart;

  // GPU f32 arcs + CPU interval merge.
  let gpu;
  try {
    const gpuStart = performance.now();
    gpu = await runGpu(scene.poses, scene.bullets, frames, bulletsPerFrame);
    gpu.gpuMs = performance.now() - gpuStart;
  } catch (e) {
    status.textContent = 'GPU 不可用：' + (e && e.message ? e.message : e);
    detail.textContent = 'JS 精确 f64 对照已计算，但 GPU 路径未运行。请使用支持 WebGPU 的浏览器（Chrome 113+/Edge 113+）重新打开本页。';
    return;
  }

  let maxErr = 0, sumErr = 0, maxAt = '';
  let bestOpSame = true;
  for (let p = 0; p < poseCount; p++) {
    const err = Math.abs(jsScores[p] - gpu.gpuScores[p]);
    if (err > maxErr) { maxErr = err; maxAt = 'pose ' + p + ' (op ' + Math.floor(p / frames) + ', frame ' + (p % frames) + ')'; }
    sumErr += err;
  }
  for (let op = 0; op < ops; op++) {
    let jsBest = 0, gpuBest = 0;
    for (let f = 1; f < frames; f++) {
      if (jsScores[op * frames + f] > jsScores[op * frames + jsBest]) jsBest = f;
      if (gpu.gpuScores[op * frames + f] > gpu.gpuScores[op * frames + gpuBest]) gpuBest = f;
    }
    if (jsBest !== gpuBest) bestOpSame = false;
  }

  status.textContent = '完成';
  table.innerHTML =
    '<tr><th>项目</th><th>值</th></tr>' +
    '<tr><td>输入规模</td><td>' + ops + ' 操作 × ' + frames + ' 帧 = ' + poseCount +
      ' 位姿，每帧 ' + bulletsPerFrame + ' 弹</td></tr>' +
    '<tr><td>最大误差（f32 GPU vs f64 JS）</td><td>' + formatError(maxErr) + '（' + maxAt + '）</td></tr>' +
    '<tr><td>平均误差</td><td>' + formatError(sumErr / poseCount) + '</td></tr>' +
    '<tr><td>最优操作一致性（按75帧合计）</td><td>' + (bestOpSame ? '一致 PASS' : '不一致 FAIL') + '</td></tr>' +
    '<tr><td>JS 精确 f64 用时</td><td>' + jsMs.toFixed(2) + ' ms</td></tr>' +
    '<tr><td>GPU（含 CPU 区间合并/回读）用时</td><td>' + gpu.gpuMs.toFixed(2) + ' ms</td></tr>' +
    '<tr><td>GPU 每帧最大原始弧数（上限）</td><td>' + gpu.maxArcsPerPose + '</td></tr>';
  detail.textContent = 'GPU 分数未写回游戏；区间合并与 gap 评分仍在 CPU 完成，GPU 仅生成 f32 遮蔽弧段。';
}

window.addEventListener('DOMContentLoaded', function () {
  document.getElementById('run').addEventListener('click', runBenchmark);
  document.getElementById('gpuSupport').textContent = (navigator.gpu) ? 'WebGPU 可用' : 'WebGPU 不可用';
  runBenchmark();
});
