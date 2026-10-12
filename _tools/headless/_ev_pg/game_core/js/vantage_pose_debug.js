/* Vantage 目标位姿调试台 —— 挂进 T 面板（不要另开页面）
 * ================================================================
 * 用法：T 开面板 →「AI 操控」下拉选「神经网络」→ 勾选「调试内容：目标位置训练」
 *       → 地图上出现坦克虚影：左键拖动移动、右键拖动/滚轮旋转、G 开始/暂停
 *
 * 修正记录（2026-10-07）：
 *   · 不再另开页面，改为挂进 T 面板
 *   · G 键代替空格（空格是射击）
 *   · 虚影画布严格贴合游戏画布（原来被 CSS 拉伸压扁）
 *   · 鼠标落在面板/UI 上时不移动虚影、不创建虚影
 */
(function () {
  'use strict';
  if (window.__vtPoseDebug) return;
  window.__vtPoseDebug = true;

  var TILE = 10, OBS = 82, NACT = 9, HD = 128;
  var TANK_W = 3, TANK_H = 4;          // 和训练/游戏一致（单位）

  var S = {
    active: false,          // 「目标位置训练」勾选
    running: false,         // G 开关
    ghost: { x: 120, y: 120, rot: 0 },
    net: null, weightsOk: false, weightsMsg: '',
    mapCache: null, mapW: 10, mapH: 6,
    acc: 0, steps: 0, bestErr: 1e9, lastAct: -1,
    drag: 0, lastMx: 0, lastMy: 0, ghostK: 1.0,
    tankId: null, muted: [], hijacked: null,
  };

  /* ---------------- 虚影画布（严格贴合游戏画布） ---------------- */
  var cv, ctx;
  function ensureCanvas() {
    if (cv) return true;
    var g = window.GameManager && GameManager.getGame && GameManager.getGame();
    if (!g) return false;
    cv = document.createElement('canvas');
    cv.id = 'vtPoseCanvas';
    cv.style.cssText = 'position:fixed;left:0;top:0;pointer-events:none;z-index:200;';
    document.body.appendChild(cv);
    ctx = cv.getContext('2d');
    return true;
  }

  // 让虚影画布和游戏画布的**屏幕矩形**逐像素对齐（修「压扁」）
  function syncCanvasRect() {
    if (!cv) return;
    var g = GameManager.getGame(); if (!g) return;
    var gcv = g.canvas; if (!gcv) return;
    var r = gcv.getBoundingClientRect();
    var dpr = window.devicePixelRatio || 1;
    cv.style.left = r.left + 'px';
    cv.style.top = r.top + 'px';
    cv.style.width = r.width + 'px';
    cv.style.height = r.height + 'px';
    var w = Math.max(1, Math.round(r.width * dpr));
    var h = Math.max(1, Math.round(r.height * dpr));
    if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
    return { w: w, h: h, dpr: dpr, cssW: r.width, cssH: r.height, gameW: g.width, gameH: g.height };
  }

  /* ---------------- 网络 ---------------- */
  var h1 = new Float32Array(HD), h2 = new Float32Array(HD), lg = new Float32Array(NACT);
  function buildNet(w) {
    var p = 0; function take(n) { var a = w.subarray(p, p + n); p += n; return a; }
    S.net = { w1: take(OBS*HD), b1: take(HD), w2: take(HD*HD), b2: take(HD),
              w3: take(HD*NACT), b3: take(NACT), w4: take(HD), b4: take(1) };
  }
  function lin(x, w, b, nin, nout, out) {
    for (var o = 0; o < nout; o++) { var s = b[o], base = o * nin;
      for (var i = 0; i < nin; i++) s += x[i] * w[base + i]; out[o] = s; }
  }
  function forward(o) {
    if (!S.net) return -1;
    lin(o, S.net.w1, S.net.b1, OBS, HD, h1);
    for (var i = 0; i < HD; i++) if (h1[i] < 0) h1[i] = 0;
    lin(h1, S.net.w2, S.net.b2, HD, HD, h2);
    for (var j = 0; j < HD; j++) if (h2[j] < 0) h2[j] = 0;
    lin(h2, S.net.w3, S.net.b3, HD, NACT, lg);
    for (var k = 0; k < NACT; k++) if (!isFinite(lg[k])) return -1;   // 权重坏了就返回 -1
    var a = 0; for (var m = 1; m < NACT; m++) if (lg[m] > lg[a]) a = m;
    return a;
  }
  function loadWeights() {
    S.weightsMsg = '加载中…';
    fetch('external_ai/nn/agent_v3.json?t=' + Date.now())
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        if (!j || !j.w) { S.weightsMsg = '没找到权重（先跑训练）'; S.weightsOk = false; return; }
        buildNet(Float32Array.from(j.w));
        S.weightsOk = true; S.weightsMsg = '已加载 ' + j.w.length + ' 参数';
      })
      .catch(function (e) { S.weightsMsg = '加载失败: ' + e.message; S.weightsOk = false; });
  }

  /* ---------------- 观测（必须和 rollout_worker_v3.js 一致） ---------------- */
  function buildMap() {
    var gc = GameManager.getGameController(); if (!gc) return null;
    var mz = gc.getMaze(); if (!mz) return null;
    S.mapW = Math.min(mz.width, 10); S.mapH = Math.min(mz.height, 6);
    var g = new Float32Array(60);
    for (var y = 0; y < 6; y++) for (var x = 0; x < 10; x++) {
      if (x >= mz.width || y >= mz.height) { g[y*10+x] = -1; continue; }
      var ins = false; try { ins = !!mz.isPositionInsideMaze({x:x,y:y}); } catch (e) {}
      g[y*10+x] = ins ? 0 : 1;
    }
    S.mapCache = g; return mz;
  }
  function mdOf(mz, x, y, bx, by) {
    try { var d = mz.getDistanceBetweenPositions(
        {x: Math.floor(x/TILE), y: Math.floor(y/TILE)},
        {x: Math.floor(bx/TILE), y: Math.floor(by/TILE)});
      return (d === false || d == null) ? 99 : d; } catch (e) { return 99; }
  }
  var NB = [[0,-1],[1,-1],[1,0],[1,1],[0,1],[-1,1],[-1,0],[-1,-1]];
  function obsOf(mz, ax, ay, rot, B) {
    var o = new Float32Array(OBS);
    o[0]=ax/100; o[1]=ay/100; o[2]=Math.sin(rot); o[3]=Math.cos(rot);
    o[4]=B.x/100; o[5]=B.y/100; o[6]=Math.sin(B.rot); o[7]=Math.cos(B.rot);
    o[8]=S.mapW/10; o[9]=S.mapH/6;
    if (S.mapCache) for (var i=0;i<60;i++) o[10+i]=S.mapCache[i];
    var md = mdOf(mz, ax, ay, B.x, B.y);
    var tx = Math.floor(ax/TILE), ty = Math.floor(ay/TILE);
    var bi = -1, bv = 1e9;
    var nv = new Float32Array(8);
    for (var k = 0; k < 8; k++) {
      var v = mdOf(mz, (tx+NB[k][0])*TILE+5, (ty+NB[k][1])*TILE+5, B.x, B.y);
      nv[k] = Math.max(-1, Math.min(1, (v - md) / 5));
      if (v < bv) { bv = v; bi = k; }
    }
    var wp = (bi >= 0 && bv < md) ? { x:(tx+NB[bi][0])*TILE+5, y:(ty+NB[bi][1])*TILE+5 }
                                  : { x:B.x, y:B.y };
    var wdx = wp.x-ax, wdy = wp.y-ay, wd = Math.sqrt(wdx*wdx+wdy*wdy);
    var wb = Math.atan2(wdy, wdx) - rot;
    while (wb > Math.PI) wb -= 2*Math.PI;
    while (wb < -Math.PI) wb += 2*Math.PI;
    // ★ 必须和 rollout_worker_v3.js 的 __vtObs 布局逐位一致：
    //   [70..72]=路径点方位  [73]=md  [74..81]=8邻居
    o[70] = Math.sin(wb); o[71] = Math.cos(wb); o[72] = wd/20;
    o[73] = md/10;
    for (var m = 0; m < 8; m++) o[74+m] = nv[m];
    return o;
  }

  /* ---------------- 驾驶 ---------------- */
  var ACT=[null,{fwd:1},{back:1},{left:1},{right:1},{fwd:1,left:1},{fwd:1,right:1},{back:1,left:1},{back:1,right:1}];
  function detectTankId() {
    // ★ 调试台控制的是【Vantage 那辆坦克】，不是玩家自己的坦克
    try {
      if (window.AIs && AIs.aiManagers) {
        for (var i = 0; i < AIs.aiManagers.length; i++) {
          var m = AIs.aiManagers[i];
          if (!m) continue;
          var id = m.aiId || (m.ai && m.ai.aiId);
          if (!id) continue;
          if (m.isVantage || m.isHybrid || String(id).indexOf('vantage_') === 0 ||
              String(id).indexOf('hybrid_') === 0) return id;
        }
      }
      var gc = GameManager.getGameController();
      if (!gc || !gc.getActivePlayerIds) return null;
      var ids = gc.getActivePlayerIds() || [];
      var aiIds = [];
      if (window.AIs && AIs.aiManagers) for (var k=0;k<AIs.aiManagers.length;k++) aiIds.push(AIs.aiManagers[k].aiId);
      for (var j=0;j<ids.length;j++) if (aiIds.indexOf(ids[j]) >= 0) return ids[j];  // 退而求其次：任意 AI
      return ids[0] || null;
    } catch (e) { return null; }
  }
  function ensureCtrl() {
    if (!window.__vtCtrl) window.__vtCtrl = {fwd:0,back:0,left:0,right:0,fire:0};
    if (!S.tankId) S.tankId = detectTankId();
    if (S.tankId) window.__vtTankId = S.tankId;
    if (window.__vtPoseHook) return;
    window.__vtPoseHook = true;
    var loop = function () {
      requestAnimationFrame(loop);
      if (!S.active || !S.running) return;
      var gc = GameManager.getGameController(); if (!gc || !gc.getTank) return;
      if (!S.tankId || !gc.getTank(S.tankId)) return;
      var c = window.__vtCtrl;
      try {
        gc.setInputState({
          getPlayerId: function(){ return S.tankId; },
          getForward: function(){ return !!c.fwd; }, getBack: function(){ return !!c.back; },
          getLeft: function(){ return !!c.left; }, getRight: function(){ return !!c.right; },
          getFire: function(){ return false; }
        });
      } catch (e) {}
    };
    requestAnimationFrame(loop);
  }
  function applyAct(a) {
    var o = ACT[a] || {}; var c = window.__vtCtrl;
    c.fwd=!!o.fwd; c.back=!!o.back; c.left=!!o.left; c.right=!!o.right; c.fire=false;
  }
  function stopAll() { var c = window.__vtCtrl; if (c) { c.fwd=c.back=c.left=c.right=false; } }

  /* ---------------- 交互（面板优先） ---------------- */
  // 只把「T 面板那棵 DOM 子树」算作 UI —— 用启发式（fixed 大元素）会把全屏容器也算进去，
  // 导致所有点击都被吞掉。
  function panelRoot() {
    var host = document.querySelector('[data-act="aiop-select"]');
    if (!host) return null;
    var node = host;
    for (var i = 0; i < 12; i++) {
      if (!node.parentNode || node.parentNode === document.body) break;
      node = node.parentNode;
    }
    return node;
  }
  function pointOnUI(clientX, clientY) {
    var el = document.elementFromPoint(clientX, clientY);
    if (!el) return false;
    var root = panelRoot();
    if (root && root.contains && root.contains(el)) return true;   // 面板内部 → UI
    // 其它 fixed 浮层（弹窗等）也当 UI，但排除覆盖全屏的容器
    if (el.tagName === 'CANVAS' && el !== cv) return false;        // 游戏画布 → 可以操作
    return false;
  }
  // ★ 游戏世界坐标(0~100) 和画布像素不是 1:1。用迷宫瓦片边界算真实比例。
  var PPU = 0;
  function pxPerUnit() {
    if (PPU) return PPU;
    try {
      var mz = GameManager.getGameController().getMaze();
      if (mz && mz.getTileBounds) {
        var b = mz.getTileBounds({ x: 0, y: 0 });
        if (b && b.width) { PPU = b.width / TILE; return PPU; }
        if (b && b.w) { PPU = b.w / TILE; return PPU; }
      }
    } catch (e) {}
    try {
      var mz2 = GameManager.getGameController().getMaze();
      var g = GameManager.getGame();
      if (mz2 && g) { PPU = (g.width * 0.56) / (mz2.width * TILE); return PPU; }
    } catch (e) {}
    PPU = 5.76;
    return PPU;
  }

  function toGame(clientX, clientY) {
    var g = GameManager.getGame(); var gcv = g.canvas;
    var r = gcv.getBoundingClientRect();
    var cs = g.width / r.width, ppu = pxPerUnit();
    return { x: (clientX - r.left) * cs / ppu, y: (clientY - r.top) * cs / ppu };
  }
  document.addEventListener('mousedown', function (e) {
    if (!S.active) return;
    if (pointOnUI(e.clientX, e.clientY)) return;     // 点在面板上 → 忽略
    if (e.button !== 0 && e.button !== 2) return;
    S.drag = e.button === 2 ? 2 : 1;
    var p = toGame(e.clientX, e.clientY);
    S.lastMx = p.x; S.lastMy = p.y;
    if (S.drag === 1) { S.ghost.x = p.x; S.ghost.y = p.y; if (window.__vtPoseTarget) { window.__vtPoseTarget.x = p.x; window.__vtPoseTarget.y = p.y; } }
    e.preventDefault();
  }, true);
  document.addEventListener('mousemove', function (e) {
    if (!S.drag) return;
    var p = toGame(e.clientX, e.clientY);
    if (S.drag === 1) { S.ghost.x = p.x; S.ghost.y = p.y; }
    else { S.ghost.rot += (p.x - S.lastMx) * 0.01; if (window.__vtPoseTarget) window.__vtPoseTarget.rot = S.ghost.rot; }
    S.lastMx = p.x; S.lastMy = p.y;
    e.preventDefault();
  }, true);
  document.addEventListener('mouseup', function () { S.drag = 0; }, true);
  document.addEventListener('contextmenu', function (e) {
    if (S.active && !pointOnUI(e.clientX, e.clientY)) e.preventDefault();
  }, true);
  document.addEventListener('wheel', function (e) {
    if (!S.active || pointOnUI(e.clientX, e.clientY)) return;
    S.ghost.rot += (e.deltaY > 0 ? 1 : -1) * 0.12;
    if (window.__vtPoseTarget) window.__vtPoseTarget.rot = S.ghost.rot;
    e.preventDefault();
  }, { passive: false, capture: true });
  document.addEventListener('keydown', function (e) {
    if (!S.active) return;
    if (e.key === 'g' || e.key === 'G') {          // ★ G 键（空格是射击）
      S.running = !S.running; S.steps = 0; S.bestErr = 1e9;
      if (!S.running) stopAll();
      if (S.running && !S.net) loadWeights();
      e.preventDefault();
    }
  }, true);

  /* ---------------- 渲染 ---------------- */
  var infoEl = null;
  function render() {
    requestAnimationFrame(render);        // ★ 必须在最前面 —— 否则提前 return 会让循环永久死掉
    if (!ensureCanvas()) return;
    var info = syncCanvasRect();
    if (!info) return;
    var dpr = info.dpr;
    var scale = (info.cssW / info.gameW) * pxPerUnit() * dpr * S.ghostK;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, cv.width, cv.height);
    if (!S.active) return;

    // —— 诊断：画一层可见边框，确认画布真的在渲染 ——
    ctx.save();
    ctx.strokeStyle = 'rgba(0,255,200,0.5)'; ctx.lineWidth = 3;
    ctx.strokeRect(1.5, 1.5, cv.width - 3, cv.height - 3);
    ctx.font = '16px monospace'; ctx.fillStyle = 'rgba(0,255,200,0.9)';
    ctx.fillText('scale=' + scale.toFixed(2) + '  ppu=' + pxPerUnit().toFixed(2) +
                 '  canvas=' + cv.width + 'x' + cv.height +
                 '  ghost=(' + S.ghost.x.toFixed(0) + ',' + S.ghost.y.toFixed(0) + ')', 12, 24);
    ctx.fillText('tankId=' + (S.tankId || '未识别') + '  running=' + S.running +
                 '  steps=' + S.steps + '  act=' + S.lastAct + '  ghostK=' + S.ghostK.toFixed(2) + ' ([ ] 调大小)', 12, 48);
    ctx.restore();

    // —— 虚影：严格按坦克真实尺寸 3×4（游戏坐标）绘制 ——
    ctx.save();
    ctx.scale(scale, scale);
    ctx.translate(S.ghost.x, S.ghost.y);
    ctx.rotate(S.ghost.rot + Math.PI / 2);      // rot=0 朝 -y
    ctx.globalAlpha = 0.55;
    ctx.fillStyle = '#00e0a0'; ctx.strokeStyle = '#00ffd0'; ctx.lineWidth = 0.35;
    ctx.beginPath(); ctx.rect(-TANK_W/2, -TANK_H/2, TANK_W, TANK_H); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#7fffd4';
    ctx.beginPath(); ctx.rect(-0.35, -TANK_H/2 - 1.6, 0.7, 1.9); ctx.fill();
    ctx.globalAlpha = 1; ctx.strokeStyle = '#00ffd0'; ctx.lineWidth = 0.2;
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, -2.6); ctx.stroke();
    ctx.restore();

    // —— 面板信息 ——
    if (!infoEl) {
      infoEl = document.createElement('div');
      infoEl.style.cssText = 'margin:4px 0;padding:5px 7px;background:#181825;border:1px solid #45475a;' +
        'border-radius:5px;color:#9cf;font:11px/1.5 Consolas,monospace;white-space:pre';
      var host = document.querySelector('[data-act="aiop-select"]');
      if (host && host.parentNode) host.parentNode.appendChild(infoEl);
    }
    if (infoEl) {
      var gc = GameManager.getGameController();
      if (!S.tankId) S.tankId = detectTankId();
      var t = (gc && gc.getTank && S.tankId) ? gc.getTank(S.tankId) : null;
      var txt;
      if (!t) txt = '找不到 Vantage 的坦克(' + (S.tankId||'未识别') + ')';
      else {
        var ax=t.getX(), ay=t.getY(), rot=t.getRotation();
        var dp=Math.sqrt((S.ghost.x-ax)*(S.ghost.x-ax)+(S.ghost.y-ay)*(S.ghost.y-ay));
        var da=Math.abs(((S.ghost.rot-rot+Math.PI*3)%(Math.PI*2))-Math.PI);
        if (dp < S.bestErr) S.bestErr = dp;
        var sim=Math.exp(-dp/6.0 - da/0.45);
        txt = '车(' + ax.toFixed(0) + ',' + ay.toFixed(0) + ') 朝向' + (rot*180/Math.PI).toFixed(0) + '°\n' +
              '位置误差 ' + dp.toFixed(1) + '   角度误差 ' + (da*180/Math.PI).toFixed(0) + '°\n' +
              '位姿相似度 ' + sim.toFixed(3) + '   最优 ' + S.bestErr.toFixed(1) + '\n' +
              '动作 ' + (S.lastAct < 0 ? '-' : S.lastAct) + '   步数 ' + S.steps + '\n' +
              '状态 ' + (S.running ? '★ 运行中（G 停）' : '暂停（G 开）') + '\n' +
              '权重 ' + S.weightsMsg;
      }
      infoEl.textContent = txt;
    }
  }

  /* ---------------- 挂进面板 ---------------- */
  function hookPanel() {
    var sel = document.querySelector('[data-act="aiop-select"]');
    if (!sel || sel.__vtHooked) return false;
    sel.__vtHooked = true;

    // 1) 加「神经网络」选项
    if (!sel.querySelector('option[value="-3"]')) {
      var op = document.createElement('option');
      op.value = '-3'; op.textContent = '神经网络';
      sel.appendChild(op);
    }
    // 2) 加「调试内容：目标位置训练」勾选框
    var box = document.createElement('label');
    box.style.cssText = 'display:block;margin-top:4px;cursor:pointer;color:#a6e3a1';
    box.innerHTML = '<input type="checkbox" data-act="exp-poseTarget"> 调试内容：目标位置训练';
    sel.parentNode.insertBefore(box, sel.nextSibling);
    var chk = box.querySelector('input');
    chk.addEventListener('change', function () {
      S.active = !!chk.checked;
      if (S.active) {
        ensureCtrl();
        var gc = GameManager.getGameController();
        var mz = gc && gc.getMaze && gc.getMaze();
        if (mz) buildMap();
        var t = gc && gc.getTank && S.tankId ? gc.getTank(S.tankId) : null;
        if (t) { S.ghost.x = t.getX() + 60; S.ghost.y = t.getY() - 40; }
        // ★ 走树：写入目标位姿 + 切到 'pose' 智能体（由树的 agentSeam 消费）
        window.__vtPoseTarget = { x: S.ghost.x, y: S.ghost.y, rot: S.ghost.rot };
        try {
          if (window.VantageTreeInterface && VantageTreeInterface.Agents) {
            VantageTreeInterface.Agents.use('pose');
            console.log('[VantagePose] 已切到 pose 智能体（走树）');
          }
        } catch (e) { console.warn('[VantagePose] 切智能体失败', e); }
        window.__vtPoseDebugOn = true;
        console.log('[VantagePose] 调试台已激活 tankId=', S.tankId);
      } else {
        S.running = false; stopAll();
        window.__vtPoseTarget = null;
        window.__vtPoseDebugOn = false;
        try { if (window.VantageTreeInterface && VantageTreeInterface.Agents) VantageTreeInterface.Agents.use('rule'); } catch (e) {}
        console.log('[VantagePose] 已切回 rule');
      }
    });

    // 3) ★ 捕获阶段拦截 value=-3：面板原逻辑会把它解析成"静止"，必须抢在前面
    // ★ 必须在 document 的捕获阶段拦：同一个元素上的 capture 监听器
    //   不保证先于 bubble 监听器执行（按注册顺序），而我的注册在面板之后。
    document.addEventListener('change', function (e) {
      if (e.target !== sel) return;
      if (parseInt(sel.value, 10) !== -3) return;
      e.stopPropagation();                       // 不让事件到达 select 上的面板 handler
      e.stopImmediatePropagation();
      state_patchAiControl();
      if (!chk.checked) { chk.checked = true; chk.dispatchEvent(new Event('change')); }
      try { sel.blur(); } catch (er) {}
    }, true);

    // 4) 面板里显示当前模式
    if (!sel.querySelector('option[value="-3"]')) { /* 上面已加 */ }

    // 4) 面板动作：把 -3 交给调试台（不去动树上原来的 auto/tree 语义）
    var orig = window.__vtPosePanelAction;
    return true;
  }

  /* ---------------- 和面板/树寻路抢控制权 ---------------- */
  function state_patchAiControl() {
    try {
      if (window.VantageTestbench && VantageTestbench.getState) {
        var st = VantageTestbench.getState();
        if (st && st.aiControl) { st.aiControl.enabled = false; st.aiControl.auto = false; st.aiControl.tree = false; }
      }
      if (window.VantageTree && VantageTree.clearMoveTarget) VantageTree.clearMoveTarget();
      // ★ 关键：不要清空 ai.update（那样 inputState 会停在"什么都不做"，
      //   而管理器仍每帧提交它，反而把我们的输入覆盖掉）。
      //   正确做法：劫持 getInputState —— 走游戏自己的 AI 通道，输入必然到坦克。
      if (window.AIs && AIs.aiManagers) {
        for (var i2 = 0; i2 < AIs.aiManagers.length; i2++) {
          var mgr2 = AIs.aiManagers[i2];
          if (!mgr2 || !mgr2.ai) continue;
          var id2 = mgr2.aiId || (mgr2.ai && mgr2.ai.aiId);
          if (id2 !== S.tankId) continue;
          if (!mgr2.__vpdHijack) {
            mgr2.__vpdHijack = true;
            mgr2.ai.getInputState = function () {
              var c = window.__vtCtrl || {fwd:0,back:0,left:0,right:0,fire:0};
              try {
                return InputState.withState(S.tankId, !!c.fwd, !!c.back, !!c.left, !!c.right, !!c.fire);
              } catch (e) { return mgr2.__vpdOrigIn || null; }
            };
            if (!S.hijacked) { S.hijacked = []; }
            S.hijacked.push(id2);
          }
        }
      }
    } catch (e) {}
  }

  /* ---------------- 主循环 ---------------- */
  function step() {
    requestAnimationFrame(step);
    if (!S.active) return;
    var gc = GameManager.getGameController(); if (!gc) return;
    if (!S.tankId) S.tankId = detectTankId();
    var t = (gc.getTank && S.tankId) ? gc.getTank(S.tankId) : null; if (!t) return;
    var mz = gc.getMaze(); if (!mz) return;
    // ★ 不再直接驱动坦克 —— 由「pose 智能体 + 树」负责。
    //   这里只把目标位姿同步给树，并统计进度。
    if (window.__vtPoseTarget) {
      window.__vtPoseTarget.x = S.ghost.x;
      window.__vtPoseTarget.y = S.ghost.y;
      window.__vtPoseTarget.rot = S.ghost.rot;
      S.steps++;
    }
    var st = window.__vtPoseStats;
    if (st && st.lastBest) { S.lastAct = st.lastBest.op; }
  }

  function boot() {
    if (!hookPanel()) { setTimeout(boot, 800); return; }
    ensureCtrl();
    requestAnimationFrame(render);
    requestAnimationFrame(step);
  }
  if (document.readyState === 'complete' || document.readyState === 'interactive') setTimeout(boot, 1500);
  else document.addEventListener('DOMContentLoaded', function () { setTimeout(boot, 1500); });
})();
