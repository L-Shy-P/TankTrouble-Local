# -*- coding: utf-8 -*-
"""
生成 rollout_worker_v3.js —— 全地图观测版
==========================================
观测 14 → 177：
  [0..3]    自身位姿     ax/100, ay/100, sin(rot), cos(rot)
  [4..7]    目标位姿     bx/100, by/100, sin(tRot), cos(tRot)
  [8..167]  全地图 16×10 (1=墙,0=空)   ← 用户要求：整个地图直接输入
  [168]     距离场 md/10                ┐ 脚手架，阶段 C 起置 0
  [169..176] 8 邻居 md 差值              ┘
"""
import io, sys
sys.stdout.reconfigure(encoding='utf-8')

src = '_tools/headless/rollout_worker_v2.js'
dst = '_tools/headless/rollout_worker_v3.js'
s = io.open(src, encoding='utf-8').read()
done = []

MAP_W, MAP_H, MAP_N = 16, 10, 160
OBS = 4 + 4 + MAP_N + 9      # 177

# ---------- 1) __vtNet / __vtFwd: 14 → 177 ----------
s = s.replace("w1: take(14 * 64)", f"w1: take({OBS} * 64)", 1)
s = s.replace("linear(obs, net.w1, net.b1, 14, 64, h1)", f"linear(obs, net.w1, net.b1, {OBS}, 64, h1)", 1)
s = s.replace("const WPARAMS = 14 * 64 + 64", f"const WPARAMS = {OBS} * 64 + 64", 1)
done.append('net')

# ---------- 2) __vtObs 整体替换 ----------
i = s.find("// ---------- 观测 ----------")
j = s.find("window.__vtAct = function (a) {")
assert i > 0 and j > i, 'obs anchor'
NEW_OBS = f'''// ---------- 观测（v3：全地图）----------
window.__vtMapW = {MAP_W}; window.__vtMapH = {MAP_H};

// 全地图：一次性构建（一局内不变），160 维
window.__vtBuildMap = function () {{
  var mz = GameManager.getGameController().getMaze();
  var g = new Float32Array({MAP_N});
  for (var y = 0; y < {MAP_H}; y++) {{
    for (var x = 0; x < {MAP_W}; x++) {{
      var inside = false;
      try {{ inside = !!mz.isPositionInsideMaze({{ x: x, y: y }}); }} catch (e) {{ inside = false; }}
      g[y * {MAP_W} + x] = inside ? 0 : 1;      // 1 = 墙/不可通行
    }}
  }}
  window.__vtMapCache = g;
  return g;
}};

window.__vtObs = function (ax, ay, rot, bx, by, trot, md, neigh) {{
  var o = new Float32Array({OBS});
  o[0] = ax / 100; o[1] = ay / 100;
  o[2] = Math.sin(rot); o[3] = Math.cos(rot);
  o[4] = bx / 100; o[5] = by / 100;
  o[6] = Math.sin(trot || 0); o[7] = Math.cos(trot || 0);
  // ★ 全地图
  var g = window.__vtMapCache;
  if (g) {{ for (var i = 0; i < {MAP_N}; i++) o[8 + i] = g[i]; }}
  // 距离场脚手架（阶段 C 传 null 则全 0）
  var base = 8 + {MAP_N};
  if (md !== null && md !== undefined) {{
    o[base] = md / 10;
    if (neigh) {{ for (var k = 0; k < 8; k++) o[base + 1 + k] = neigh[k]; }}
  }}
  return o;
}};

'''
s = s[:i] + NEW_OBS + s[j:]
done.append('obs')

# ---------- 3) __vtEpisode：建地图 + 算距离场 + 传新 obs ----------
s = s.replace("  var traj = [], pathLen = 0, stillFrames = 0, reached = false;",
              "  window.__vtBuildMap();\n"
              "  var traj = [], pathLen = 0, stillFrames = 0, reached = false;", 1)

# 换成带缓存的邻居距离场
old_md = """  function mdOf(x, y) {
    try {
      var d = mz.getDistanceBetweenPositions({x: tileOf(x), y: tileOf(y)},
                                             {x: tileOf(B.x), y: tileOf(B.y)});
      return (d === false || d === null || d === undefined) ? 99 : d;
    } catch (e) { return 99; }
  }"""
new_md = """  function mdAt(tx, ty) {
    try {
      var d = mz.getDistanceBetweenPositions({x: tx, y: ty},
                                             {x: tileOf(B.x), y: tileOf(B.y)});
      return (d === false || d === null || d === undefined) ? 99 : d;
    } catch (e) { return 99; }
  }
  function mdOf(x, y) { return mdAt(tileOf(x), tileOf(y)); }
  // ★ 8 邻居距离场（缓存：同一格内不变，只在换格时重算 8 次）
  var _cTile = -9999, _cN = null, _cMd = -1;
  function dfAt(x, y) {
    var tx = tileOf(x), ty = tileOf(y), key = ty * 1000 + tx;
    if (key !== _cTile) {
      _cTile = key; _cMd = mdAt(tx, ty);
      var NB = [[0,-1],[1,-1],[1,0],[1,1],[0,1],[-1,1],[-1,0],[-1,-1]];
      _cN = new Float32Array(8);
      for (var k = 0; k < 8; k++) {
        var v = mdAt(tx + NB[k][0], ty + NB[k][1]);
        _cN[k] = Math.max(-1, Math.min(1, (v - _cMd) / 5));   // 归一化到 [-1,1]
      }
    }
    return { md: _cMd, neigh: _cN };
  }"""
assert old_md in s, 'mdOf anchor'
s = s.replace(old_md, new_md, 1)

# 观测调用点
s = s.replace("    var obs = window.__vtObs(ax, ay, rot, B.x, B.y, bRot);",
              "    var df = USE_DF ? dfAt(ax, ay) : null;\n"
              "    var obs = window.__vtObs(ax, ay, rot, B.x, B.y, bRot,\n"
              "                             df ? df.md : null, df ? df.neigh : null);", 1)
# 距离场开关（阶段 C 起关）
s = s.replace("  var bRot = B.rot || 0;",
              "  var bRot = B.rot || 0;\n"
              "  var USE_DF = (CFG.USE_DF === undefined) ? true : !!CFG.USE_DF;   // 阶段C起关掉脚手架", 1)
done.append('episode')

# ---------- 4) 训练侧 OBS ----------
t = 'tools/nn/stage1p_ppo.py'
p = io.open(t, encoding='utf-8').read()
p = p.replace("OBS, NACT, H = 14, 9, 64", f"OBS, NACT, H = {OBS}, 9, 64")
# 各阶段加 USE_DF
p = p.replace("dict(name='A引导', W_FIELD=0.5, P_FIELD=0.7, W_POSE=0.0, TIME_BONUS=0.0,",
              "dict(name='A引导', W_FIELD=0.5, P_FIELD=0.7, W_POSE=0.0, TIME_BONUS=0.0, USE_DF=True,")
p = p.replace("dict(name='B过渡', W_FIELD=0.2, P_FIELD=0.7, W_POSE=1.0, TIME_BONUS=0.0,",
              "dict(name='B过渡', W_FIELD=0.2, P_FIELD=0.7, W_POSE=1.0, TIME_BONUS=0.0, USE_DF=True,")
for nm in ['C严格', 'D加速', 'E精致']:
    p = p.replace(f"dict(name='{nm}', W_FIELD=0.0, P_FIELD=0.7, W_POSE=2.0, TIME_BONUS=",
                  f"dict(name='{nm}', W_FIELD=0.0, P_FIELD=0.7, W_POSE=2.0, USE_DF=False, TIME_BONUS=")
p = p.replace("TIME_BONUS=S['TIME_BONUS'], SP=6.0", "TIME_BONUS=S['TIME_BONUS'], USE_DF=S.get('USE_DF', True), SP=6.0")
# 权重文件名换掉，避免和旧维度的冲突
p = p.replace("weights_v2.json", "weights_v3.json").replace("rollout_v2.jsonl", "rollout_v3.jsonl")
p = p.replace("train_v2.log", "train_v3.log").replace("rollout_worker_v2.js", "rollout_worker_v3.js")
io.open(t, 'w', encoding='utf-8').write(p)
done.append('trainer')

# ---------- 5) 输出文件名 ----------
s = s.replace("'weights_v2.json'", "'weights_v3.json'")
io.open(dst, 'w', encoding='utf-8').write(s)
print('生成', dst, '| OBS =', OBS, '| 变更:', done)
