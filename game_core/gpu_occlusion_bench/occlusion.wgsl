// GPU occlusion-arc generator for the Vantage single-frame occlusion score.
// It mirrors the JS copy-area-2 `exactOcclusion` arc-generation step in f32.
// Interval merging + gap scoring are deliberately left on the CPU.

struct Pose {
  x: f32,
  y: f32,
  rot: f32,
};

struct Bullet {
  x: f32,
  y: f32,
};

struct RawArc {
  start: f32,
  end: f32,
};

struct Params {
  poseCount: u32,
  frameCount: u32,
  bulletsPerFrame: u32,
  maxArcsPerPose: u32,
  twoPi: f32,
  pi: f32,
  halfPi: f32,
  geoOffset: f32,
  rAbs: f32,
  rSemi: f32,
  effHalfW: f32,
  effHalfH: f32,
};

@group(0) @binding(0) var<storage, read> poses: array<Pose>;
@group(0) @binding(1) var<storage, read> bullets: array<Bullet>;
@group(0) @binding(2) var<storage, read_write> arcs: array<RawArc>;
@group(0) @binding(3) var<storage, read_write> arcCounts: array<u32>;
@group(0) @binding(4) var<storage, read_write> fullOcclusion: array<u32>;
@group(0) @binding(5) var<uniform> params: Params;

fn normAngle(a: f32) -> f32 {
  var x = a % params.twoPi;
  if (x < 0.0) {
    x = x + params.twoPi;
  }
  return x;
}

fn pushArc(poseIdx: u32, arcCount: u32, start: f32, end: f32) -> u32 {
  if (arcCount >= params.maxArcsPerPose) {
    return arcCount;
  }
  let idx = poseIdx * params.maxArcsPerPose + arcCount;
  arcs[idx].start = start;
  arcs[idx].end = end;
  return arcCount + 1u;
}

fn testArc(
    poseIdx: u32,
    arcCount: u32,
    aLo: f32,
    aHi: f32,
    bLo: f32,
    bHi: f32,
) -> u32 {
  let lo0 = max(aLo, bLo);
  let hi0 = min(aHi, bHi);
  if (lo0 >= hi0 - 1e-6) {
    return arcCount;
  }
  let lo = normAngle(lo0);
  let hi = normAngle(hi0);
  var c = arcCount;
  if (lo < hi) {
    c = pushArc(poseIdx, c, lo, hi);
  } else {
    c = pushArc(poseIdx, c, lo, params.twoPi);
    c = pushArc(poseIdx, c, 0.0, hi);
  }
  return c;
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let p = gid.x;
  if (p >= params.poseCount) {
    return;
  }

  let pose = poses[p];
  // Pose layout is op-major: poseIndex = opIndex * frameCount + frame.
  let frame = p % params.frameCount;
  let bulletBase = frame * params.bulletsPerFrame;

  let gx = pose.x + sin(pose.rot) * params.geoOffset;
  let gy = pose.y - cos(pose.rot) * params.geoOffset;

  // R_ABS / R_SEMI coarse filter, exactly like JS occlusionIntervals.
  var full = 0u;
  var anySemi = false;
  for (var b = 0u; b < params.bulletsPerFrame; b = b + 1u) {
    let bl = bullets[bulletBase + b];
    let dx = bl.x - gx;
    let dy = bl.y - gy;
    let d2 = dx * dx + dy * dy;
    if (d2 < params.rAbs * params.rAbs) {
      full = 1u;
      break;
    }
    if (d2 < params.rSemi * params.rSemi) {
      anySemi = true;
    }
  }

  if (full == 1u) {
    fullOcclusion[p] = 1u;
    arcCounts[p] = 0u;
    return;
  }
  if (!anySemi) {
    fullOcclusion[p] = 0u;
    arcCounts[p] = 0u;
    return;
  }

  fullOcclusion[p] = 0u;
  var arcCount = 0u;

  for (var b = 0u; b < params.bulletsPerFrame; b = b + 1u) {
    let bl = bullets[bulletBase + b];
    let dx = bl.x - gx;
    let dy = bl.y - gy;
    let d2 = dx * dx + dy * dy;
    if (d2 >= params.rSemi * params.rSemi) {
      continue;
    }
    let D = sqrt(d2);
    if (D <= 1e-6) {
      continue;
    }

    let aW = asin(clamp(params.effHalfW / D, 0.0, 1.0));
    let aH = asin(clamp(params.effHalfH / D, 0.0, 1.0));
    if (aW + aH < params.halfPi - 1e-6) {
      continue;
    }
    if (aW >= params.halfPi - 1e-6) {
      arcCount = pushArc(p, arcCount, 0.0, params.twoPi);
      continue;
    }

    let theta = atan2(dy, dx);
    let sinB = vec4<f32>(
      theta - aW,
      theta + aW,
      theta + params.pi - aW,
      theta + params.pi + aW,
    );
    let cosB = vec4<f32>(
      theta + params.halfPi - aH,
      theta + params.halfPi + aH,
      theta + 3.0 * params.halfPi - aH,
      theta + 3.0 * params.halfPi + aH,
    );

    for (var sa = 0u; sa < 4u; sa = sa + 2u) {
      for (var sb = 0u; sb < 4u; sb = sb + 2u) {
        arcCount = testArc(p, arcCount, sinB[sa], sinB[sa + 1u], cosB[sb], cosB[sb + 1u]);
        arcCount = testArc(
          p,
          arcCount,
          sinB[sa] + params.twoPi,
          sinB[sa + 1u] + params.twoPi,
          cosB[sb],
          cosB[sb + 1u],
        );
        arcCount = testArc(
          p,
          arcCount,
          sinB[sa],
          sinB[sa + 1u],
          cosB[sb] - params.twoPi,
          cosB[sb + 1u] - params.twoPi,
        );
      }
    }
  }

  arcCounts[p] = arcCount;
}
