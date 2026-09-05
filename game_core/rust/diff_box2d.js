#!/usr/bin/env node
// Differential test: the game's JS Box2D vs vantage_core::box2d.
//
// 1. Loads the game's Box2D JS implementation with Node's `vm`.
// 2. Builds the fixed scene (four 20x20m walls + one dynamic rectangle).
// 3. Steps 75 x 0.02s and records [x, y, angle] after every frame.
// 4. Writes the same scene as JSON and runs the Rust `box2d_trace` CLI.
// 5. Compares the two trajectories frame by frame.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const jsPath = path.join(root, 'js', 'f1a5ef972c273fb89a098cb50b0f22e7.js');
const crateDir = path.join(root, 'rust', 'vantage_core');
const scenePath = path.join(os.tmpdir(), 'vantage_box2d_scene.json');

// ---------------------------------------------------------------------------
// Scene definition (must match diff_box2d.js + box2d_trace.rs)
// ---------------------------------------------------------------------------
const scene = {
  walls: [
    { cx: 10, cy: -1, hw: 11, hh: 1 }, // bottom, inner face y = 0
    { cx: 10, cy: 21, hw: 11, hh: 1 }, // top, inner face y = 20
    { cx: -1, cy: 10, hw: 1, hh: 11 }, // left, inner face x = 0
    { cx: 21, cy: 10, hw: 1, hh: 11 }, // right, inner face x = 20
  ],
  tank: {
    x: 5,
    y: 5,
    angle: 0.4,
    vx: 3,
    vy: 1,
    angularVelocity: 0.5,
    halfWidth: 1.5,
    halfHeight: 2,
    friction: 0.3,
    restitution: 0,
    density: 1,
  },
  steps: 75,
  dt: 0.02,
  velocityIterations: 10,
  positionIterations: 10,
};

// ---------------------------------------------------------------------------
// JS trajectory
// ---------------------------------------------------------------------------
function runJsTrajectory() {
  const src = fs.readFileSync(jsPath, 'utf8');
  const sandbox = {};
  const ctx = vm.createContext(sandbox);
  vm.runInContext(src, ctx, { filename: jsPath });
  const Box2D = sandbox.Box2D;
  if (!Box2D) throw new Error('Box2D was not defined after loading the JS file');

  const Vec2 = Box2D.Common.Math.b2Vec2;
  const World = Box2D.Dynamics.b2World;
  const Body = Box2D.Dynamics.b2Body;
  const BodyDef = Box2D.Dynamics.b2BodyDef;
  const FixtureDef = Box2D.Dynamics.b2FixtureDef;
  const PolygonShape = Box2D.Collision.Shapes.b2PolygonShape;

  const world = new World(new Vec2(0, 0), true);

  function addWall(cx, cy, hw, hh) {
    const bd = new BodyDef();
    bd.position.Set(cx, cy);
    const body = world.CreateBody(bd);
    const fd = new FixtureDef();
    fd.shape = PolygonShape.AsBox(hw, hh);
    fd.friction = 0.3;
    fd.restitution = 0;
    body.CreateFixture(fd);
    return body;
  }

  for (const w of scene.walls) addWall(w.cx, w.cy, w.hw, w.hh);

  const bd = new BodyDef();
  bd.position.Set(scene.tank.x, scene.tank.y);
  bd.angle = scene.tank.angle;
  bd.type = Body.b2_dynamicBody;
  bd.linearVelocity.Set(scene.tank.vx, scene.tank.vy);
  bd.angularVelocity = scene.tank.angularVelocity;
  const tank = world.CreateBody(bd);
  const fd = new FixtureDef();
  fd.shape = PolygonShape.AsBox(scene.tank.halfWidth, scene.tank.halfHeight);
  fd.friction = scene.tank.friction;
  fd.restitution = scene.tank.restitution;
  fd.density = scene.tank.density;
  tank.CreateFixture(fd);

  const traj = [];
  for (let i = 0; i < scene.steps; i++) {
    world.Step(scene.dt, scene.velocityIterations, scene.positionIterations);
    traj.push([
      tank.GetPosition().x,
      tank.GetPosition().y,
      tank.GetAngle(),
    ]);
  }
  return traj;
}

// ---------------------------------------------------------------------------
// Rust trajectory
// ---------------------------------------------------------------------------
function runRustTrajectory() {
  fs.writeFileSync(scenePath, JSON.stringify(scene));
  const cmd = process.platform === 'win32' ? 'cargo.exe' : 'cargo';
  const res = spawnSync(cmd, ['run', '--quiet', '--bin', 'box2d_trace', '--', scenePath], {
    cwd: crateDir,
    encoding: 'utf8',
    shell: false,
    env: Object.assign({}, process.env),
  });
  if (res.status !== 0) {
    throw new Error(
      'cargo run failed (' + res.status + ')\nstdout:\n' + res.stdout + '\nstderr:\n' + res.stderr
    );
  }
  const stdout = (res.stdout || '').trim();
  // The JSON array is printed on the last non-empty line (cargo may emit
  // warnings on stderr; stdout should contain only the JSON array).
  const lines = stdout.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const jsonLine = lines[lines.length - 1];
  return JSON.parse(jsonLine);
}

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------
function main() {
  console.log('JS Box2D file :', jsPath);
  console.log('Rust crate     :', crateDir);

  const jsTraj = runJsTrajectory();
  const rustTraj = runRustTrajectory();

  if (jsTraj.length !== rustTraj.length) {
    throw new Error(`trajectory length mismatch: JS=${jsTraj.length}, Rust=${rustTraj.length}`);
  }

  let maxPosError = 0;
  let maxAngError = 0;
  let maxPosFrame = 1;
  let maxAngFrame = 1;

  for (let i = 0; i < jsTraj.length; i++) {
    const j = jsTraj[i];
    const r = rustTraj[i];
    const dx = Math.abs(j[0] - r[0]);
    const dy = Math.abs(j[1] - r[1]);
    const posErr = Math.hypot(dx, dy);
    const angErr = Math.abs(j[2] - r[2]);
    if (posErr > maxPosError) {
      maxPosError = posErr;
      maxPosFrame = i + 1;
    }
    if (angErr > maxAngError) {
      maxAngError = angErr;
      maxAngFrame = i + 1;
    }
  }

  console.log('frames compared :', jsTraj.length);
  console.log('max position err:', maxPosError.toExponential(9), 'm at frame', maxPosFrame);
  console.log('max angle err   :', maxAngError.toExponential(9), 'rad at frame', maxAngFrame);

  const posOk = maxPosError <= 1e-6;
  const angOk = maxAngError <= 1e-6;
  console.log('position threshold: 1e-6 m  ->', posOk ? 'PASS' : 'FAIL');
  console.log('angle threshold   : 1e-6 rad ->', angOk ? 'PASS' : 'FAIL');

  if (!posOk || !angOk) {
    console.error('DIFF TEST FAILED');
    process.exitCode = 1;
  } else {
    console.log('DIFF TEST PASSED');
  }

  try {
    fs.unlinkSync(scenePath);
  } catch (_) {
    // The scene temp file is best-effort cleanup only.
  }
}

try {
  main();
} catch (e) {
  console.error('diff_box2d.js error:', e && e.stack || e);
  process.exitCode = 2;
}
