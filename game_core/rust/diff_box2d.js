#!/usr/bin/env node
// Differential test: the game's JS Box2D vs vantage_core::box2d.
//
// Runs several scenes (free motion + CCD collision scenes), compares
// [x, y, angle] after every frame, and fails if any scene exceeds 1e-6.

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
// Scene definitions (must match box2d_trace.rs)
// ---------------------------------------------------------------------------
const scenes = [
  {
    name: 'free-motion rectangle (must stay exact)',
    scene: {
      walls: [
        { cx: 10, cy: -1, hw: 11, hh: 1 },
        { cx: 10, cy: 21, hw: 11, hh: 1 },
        { cx: -1, cy: 10, hw: 1, hh: 11 },
        { cx: 21, cy: 10, hw: 1, hh: 11 },
      ],
      tank: {
        x: 5, y: 5, angle: 0.4, vx: 3, vy: 1, angularVelocity: 0.5,
        halfWidth: 1.5, halfHeight: 2, shape: 'rectangle', bullet: false,
        friction: 0.3, restitution: 0, density: 1,
      },
      steps: 75,
      dt: 0.02,
      velocityIterations: 10,
      positionIterations: 10,
    },
  },
  {
    name: 'bullet rectangle vs static wall',
    scene: {
      walls: [{ cx: 10, cy: 2, hw: 3, hh: 0.2 }],
      tank: {
        x: 10, y: 8, angle: 0, vx: 0, vy: -40, angularVelocity: 0,
        halfWidth: 0.5, halfHeight: 0.5, shape: 'rectangle', bullet: true,
        friction: 0.3, restitution: 0, density: 1,
      },
      steps: 40,
      dt: 1 / 60,
      velocityIterations: 10,
      positionIterations: 10,
    },
  },
  {
    name: 'bullet circle vs static wall',
    scene: {
      walls: [{ cx: 10, cy: 2, hw: 3, hh: 0.2 }],
      tank: {
        x: 10, y: 8, angle: 0, vx: 0, vy: -40, angularVelocity: 0,
        radius: 0.5, shape: 'circle', bullet: true,
        friction: 0.3, restitution: 0, density: 1,
      },
      steps: 40,
      dt: 1 / 60,
      velocityIterations: 10,
      positionIterations: 10,
    },
  },
  {
    name: 'bullet circle wall slide (continuous contact)',
    scene: {
      walls: [{ cx: 10, cy: 2, hw: 3, hh: 0.2 }],
      tank: {
        x: 10, y: 8, angle: 0, vx: 7, vy: -40, angularVelocity: 0,
        radius: 0.5, shape: 'circle', bullet: true,
        friction: 0.3, restitution: 0, density: 1,
      },
      steps: 40,
      dt: 1 / 60,
      velocityIterations: 10,
      positionIterations: 10,
    },
  },
  {
    name: 'fast bullet circle vs thin wall (JS TOI catches it)',
    scene: {
      walls: [{ cx: 10, cy: 2, hw: 3, hh: 0.05 }],
      tank: {
        x: 10, y: 10, angle: 0, vx: 0, vy: -80, angularVelocity: 0,
        radius: 0.25, shape: 'circle', bullet: true,
        friction: 0.3, restitution: 0, density: 1,
      },
      steps: 30,
      dt: 1 / 60,
      velocityIterations: 10,
      positionIterations: 10,
    },
  },
];

// ---------------------------------------------------------------------------
// JS trajectory
// ---------------------------------------------------------------------------
function loadBox2D() {
  const src = fs.readFileSync(jsPath, 'utf8');
  const sandbox = {};
  const ctx = vm.createContext(sandbox);
  vm.runInContext(src, ctx, { filename: jsPath });
  const Box2D = sandbox.Box2D;
  if (!Box2D) throw new Error('Box2D was not defined after loading the JS file');

  // The real game applies these overrides in B2DUtils
  // (game_core/js/b714588dc4621fe104113111ba90b1a7.js). The Rust port now
  // uses the same values; the JS side of this differential must too.
  Box2D.Common.b2Settings.b2_maxTranslation = 8.0;
  Box2D.Common.b2Settings.b2_maxTranslationSquared = 64.0;
  Box2D.Common.b2Settings.b2_velocityThreshold = 0.0;

  return Box2D;
}

function runJsTrajectory(Box2D, scene) {
  const Vec2 = Box2D.Common.Math.b2Vec2;
  const World = Box2D.Dynamics.b2World;
  const Body = Box2D.Dynamics.b2Body;
  const BodyDef = Box2D.Dynamics.b2BodyDef;
  const FixtureDef = Box2D.Dynamics.b2FixtureDef;
  const PolygonShape = Box2D.Collision.Shapes.b2PolygonShape;
  const CircleShape = Box2D.Collision.Shapes.b2CircleShape;

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
  bd.bullet = !!scene.tank.bullet;
  const tank = world.CreateBody(bd);

  const fd = new FixtureDef();
  if (scene.tank.shape === 'circle') {
    fd.shape = new CircleShape(scene.tank.radius);
  } else {
    fd.shape = PolygonShape.AsBox(scene.tank.halfWidth, scene.tank.halfHeight);
  }
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
// Rust trajectories (all scenes in one cargo invocation)
// ---------------------------------------------------------------------------
function runRustTrajectories() {
  const payload = { scenes: scenes.map((s) => s.scene) };
  fs.writeFileSync(scenePath, JSON.stringify(payload));
  const cmd = process.platform === 'win32' ? 'cargo.exe' : 'cargo';
  const env = Object.assign({}, process.env);
  // Make sure cargo is found even when node was launched without the
  // Rust toolchain on PATH.
  const cargoBin = path.join(process.env.USERPROFILE || '', '.cargo', 'bin');
  env.PATH = cargoBin + path.delimiter + (env.PATH || '');
  const res = spawnSync(cmd, ['run', '--quiet', '--bin', 'box2d_trace', '--', scenePath], {
    cwd: crateDir,
    encoding: 'utf8',
    shell: false,
    env: env,
  });
  if (res.status !== 0) {
    throw new Error(
      'cargo run failed (' + res.status + ')\nstdout:\n' + res.stdout + '\nstderr:\n' + res.stderr
    );
  }
  const stdout = (res.stdout || '').trim();
  const lines = stdout.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const jsonLine = lines[lines.length - 1];
  return JSON.parse(jsonLine);
}

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------
function compareScene(name, jsTraj, rustTraj) {
  if (jsTraj.length !== rustTraj.length) {
    throw new Error(
      '[' + name + '] trajectory length mismatch: JS=' + jsTraj.length +
      ', Rust=' + rustTraj.length
    );
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

  const posOk = maxPosError <= 1e-6;
  const angOk = maxAngError <= 1e-6;
  console.log('scene            :', name);
  console.log('  frames compared:', jsTraj.length);
  console.log('  max position err:', maxPosError.toExponential(9), 'm at frame', maxPosFrame);
  console.log('  max angle err   :', maxAngError.toExponential(9), 'rad at frame', maxAngFrame);
  console.log('  position 1e-6   :', posOk ? 'PASS' : 'FAIL');
  console.log('  angle 1e-6      :', angOk ? 'PASS' : 'FAIL');
  return posOk && angOk;
}

function main() {
  console.log('JS Box2D file :', jsPath);
  console.log('Rust crate     :', crateDir);
  console.log('');

  const Box2D = loadBox2D();
  const rustTrajs = runRustTrajectories();
  if (rustTrajs.length !== scenes.length) {
    throw new Error('scene count mismatch: JS=' + scenes.length + ', Rust=' + rustTrajs.length);
  }

  let allOk = true;
  for (let i = 0; i < scenes.length; i++) {
    const jsTraj = runJsTrajectory(Box2D, scenes[i].scene);
    const ok = compareScene(scenes[i].name, jsTraj, rustTrajs[i]);
    allOk = allOk && ok;
    console.log('');
  }

  if (!allOk) {
    console.error('DIFF TEST FAILED');
    process.exitCode = 1;
  } else {
    console.log('DIFF TEST PASSED');
  }

  try {
    fs.unlinkSync(scenePath);
  } catch (_) {
    // Best-effort cleanup only.
  }
}

try {
  main();
} catch (e) {
  console.error('diff_box2d.js error:', (e && e.stack) || e);
  process.exitCode = 2;
}
