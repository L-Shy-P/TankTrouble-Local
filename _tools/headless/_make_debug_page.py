# -*- coding: utf-8 -*-
"""
生成 game_core/vantage_pose_debug.html
=======================================
手动交互调试页：在地图上放置/拖动/旋转一个坦克虚影当初目标位姿，
让训练出来的策略开车去贴合，直观检查训练成果。

从 index.html 复制（保证同一份游戏），在 </body> 前注入调试 UI。
"""
import io, os, sys
sys.stdout.reconfigure(encoding='utf-8')

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
SRC = os.path.join(ROOT, 'game_core', 'index.html')
DST = os.path.join(ROOT, 'game_core', 'vantage_pose_debug.html')

html = io.open(SRC, encoding='utf-8').read()

INJECT = r'''
<!-- ================= Vantage 位姿调试台 ================= -->
<div id="vpdPanel" style="position:fixed;right:12px;bottom:12px;z-index:99999;
  background:rgba(20,20,24,.92);color:#ddd;font:12px/1.6 Consolas,monospace;
  padding:10px 12px;border-radius:8px;border:1px solid #444;min-width:250px">
  <div style="font-weight:bold;color:#7fd">Vantage 位姿调试台</div>
  <div id="vpdInfo" style="color:#9cf;margin:6px 0">初始化中…</div>
  <div style="color:#888;font-size:11px;border-top:1px solid #333;padding-top:6px">
    左键拖动 = 移动虚影<br>
    右键拖动 / 滚轮 = 旋转虚影<br>
    <b>空格</b> = 开始/停止 AI<br>
    <b>R</b> = 重置坦克到随机位<br>
    <b>H</b> = 隐藏/显示本面板
  </div>
</div>
<canvas id="vpdCanvas" style="position:fixed;left:0;top:0;width:100%;height:100%;
  pointer-events:none;z-index:99998"></canvas>
<script>
(function () {
  'use strict';
  var TILE = 10, W = 0, H = 0;
  var ghost = { x: 50, y: 50, rot: 0, active: false };
  var running = false, net = null, weightsLoaded = false;
  var OBS = 82, NACT = 9, HD = 128;
  var lastTank = null, epStart = null, epSteps = 0, bestErr = 1e9;
  var canvas = document.getElementById('vpdCanvas');
  var ctx = canvas.getContext('2d');
  var info = document.getElementById('vpdInfo');
  var panel = document.getElementById('vpdPanel');

  function resize() {
    var g = GameManager.getGame();
    if (!g) return;
    canvas.width = g.width; canvas.height = g.height;
    W = g.width; H = g.height;
  }

  // ---------- 权重加载 ----------
  function loadWeights() {
    fetch('external_ai/nn/../_train/weights_v3.json').catch(function(){});
    fetch('/_train/weights_v3.json').then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        if (!j || !j.w) { info.innerHTML = '⚠ 权重没找到<br>先跑训练生成 _train/weights_v3.json'; return; }
        buildNet(Float32Array.from(j.w));
        weightsLoaded = true;
      }).catch(function (e) {
        info.textContent = '⚠ 权重加载失败: ' + e.message;
      });
  }

  function buildNet(w) {
    var p = 0;
    function take(n) { var a = w.subarray(p, p + n); p += n; return a; }
    net = { w1: take(OBS*HD), b1: take(HD), w2: take(HD*HD), b2: take(HD),
            w3: take(HD*NACT), b3: take(NACT), w4: take(HD), b4: take(1) };
  }
  function lin(x, w, b, nin, nout, out) {
    for (var o = 0; o < nout; o++) { var s = b[o], base = o * nin;
      for (var i = 0; i < nin; i++) s += x[i] * w[base + i]; out[o] = s; }
  }
  var h1 = new Float32Array(HD), h2 = new Float32Array(HD), lg = new Float32Array(NACT);
  function forward(o) {
    if (!net) return null;
    lin(o, net.w1, net.b1, OBS, HD, h1);
    for (var i = 0; i < HD; i++) if (h1[i] < 0) h1[i] = 0;
    lin(h1, net.w2, net.b2, HD, HD, h2);
    for (var j = 0; j < HD; j++) if (h2[j] < 0) h2[j] = 0;
    lin(h2, net.w3, net.b3, HD, NACT, lg);
    var a = 0; for (var k = 1; k < NACT; k++) if (lg[k] > lg[a]) a = k;
    return a;
  }

  // ---------- 观测（必须和 rollout_worker_v3.js 完全一致）----------
  var mapCache = null, mapW = 10, mapH = 6;
  function buildMap() {
    var mz = GameManager.getGameController().getMaze();
    mapW = Math.min(mz.width, 10); mapH = Math.min(mz.height, 6);
    var g = new Float32Array(60);
    for (var y = 0; y < 6; y++) for (var x = 0; x < 10; x++) {
      if (x >= mz.width || y >= mz.height) { g[y*10+x] = -1; continue; }
      var ins = false; try { ins = !!mz.isPositionInsideMaze({x:x, y:y}); } catch(e) {}
      g[y*10+x] = ins ? 0 : 1;
    }
    mapCache = g;
    return mz;
  }
  function mdOf(mz, x, y, bx, by) {
    try { var d = mz.getDistanceBetweenPositions(
      {x:Math.floor(x/TILE), y:Math.floor(y/TILE)},
      {x:Math.floor(bx/TILE), y:Math.floor(by/TILE)});
      return (d===false||d==null) ? 99 : d; } catch(e) { return 99; }
  }
  function obsOf(mz, ax, ay, rot, B) {
    var o = new Float32Array(OBS);
    o[0]=ax/100; o[1]=ay/100; o[2]=Math.sin(rot); o[3]=Math.cos(rot);
    o[4]=B.x/100; o[5]=B.y/100; o[6]=Math.sin(B.rot); o[7]=Math.cos(B.rot);
    o[8]=mapW/10; o[9]=mapH/6;
    if (mapCache) for (var i=0;i<60;i++) o[10+i]=mapCache[i];
    // 距离场脚手架 + 路径点
    var md = mdOf(mz, ax, ay, B.x, B.y);
    var NB=[[0,-1],[1,-1],[1,0],[1,1],[0,1],[-1,1],[-1,0],[-1,-1]];
    var tx=Math.floor(ax/TILE), ty=Math.floor(ay/TILE);
    var nv=[], bi=-1, bv=1e9;
    for (var k=0;k<8;k++){ var v=mdOf(mz,(tx+NB[k][0])*TILE+5,(ty+NB[k][1])*TILE+5,B.x,B.y);
      nv.push(Math.max(-1,Math.min(1,(v-md)/5))); if(v<bv){bv=v;bi=k;} }
    o[70]=md/10;
    for (var m=0;m<8;m++) o[71+m]=nv[m];
    // 路径点方位
    var wp = (bi>=0 && bv<md) ? {x:(tx+NB[bi][0])*TILE+5, y:(ty+NB[bi][1])*TILE+5} : {x:B.x,y:B.y};
    var wdx=wp.x-ax, wdy=wp.y-ay, wdist=Math.sqrt(wdx*wdx+wdy*wdy);
    var wbear=Math.atan2(wdy,wdx)-rot;
    while(wbear>Math.PI) wbear-=2*Math.PI; while(wbear<-Math.PI) wbear+=2*Math.PI;
    o[79]=Math.sin(wbear); o[80]=Math.cos(wbear); o[81]=wdist/20;
    return o;
  }

  // ---------- 驾驶 ----------
  var ACT=[{}, {fwd:1},{back:1},{left:1},{right:1},{fwd:1,left:1},{fwd:1,right:1},{back:1,left:1},{back:1,right:1}];
  function setAct(a) {
    var o = ACT[a] || {};
    var c = window.__vtCtrl || (window.__vtCtrl = {fwd:0,back:0,left:0,right:0,fire:0});
    c.fwd=!!o.fwd; c.back=!!o.back; c.left=!!o.left; c.right=!!o.right; c.fire=false;
  }
  function installHook() {
    if (window.__vpdHook) return;
    window.__vpdHook = true;
    window.__vtCtrl = window.__vtCtrl || {fwd:0,back:0,left:0,right:0,fire:0};
    window.__vtTankId = window.__vtTankId || 'tank_a';
    var tick = function () {
      var gc = GameManager.getGameController();
      if (!gc || !gc.getTank) return;
      var t = gc.getTank('tank_a'); if (!t) return;
      var c = window.__vtCtrl;
      gc.setInputState({
        getPlayerId: function(){ return 'tank_a'; },
        getForward: function(){ return !!c.fwd; }, getBack: function(){ return !!c.back; },
        getLeft: function(){ return !!c.left; }, getRight: function(){ return !!c.right; },
        getFire: function(){ return false; }
      });
    };
    var old = window.requestAnimationFrame;
    (function loop() { old(loop); try { tick(); } catch(e){} })();
  }

  // ---------- 鼠标交互 ----------
  var dragMode = 0, lastMx = 0, lastMy = 0;
  canvas.style.pointerEvents = 'auto';
  function local(e) {
    var r = canvas.getBoundingClientRect();
    return { x: (e.clientX - r.left) * (canvas.width / r.width),
             y: (e.clientY - r.top) * (canvas.height / r.height) };
  }
  canvas.addEventListener('mousedown', function (e) {
    var p = local(e); dragMode = (e.button === 2) ? 2 : 1;
    lastMx = p.x; lastMy = p.y;
    if (dragMode === 1) { ghost.x = p.x; ghost.y = p.y; }
    e.preventDefault();
  });
  canvas.addEventListener('mousemove', function (e) {
    if (!dragMode) return;
    var p = local(e);
    if (dragMode === 1) { ghost.x = p.x; ghost.y = p.y; }
    else { ghost.rot += (p.x - lastMx) * 0.01; }
    lastMx = p.x; lastMy = p.y;
  });
  window.addEventListener('mouseup', function () { dragMode = 0; });
  canvas.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  canvas.addEventListener('wheel', function (e) {
    ghost.rot += (e.deltaY > 0 ? 1 : -1) * 0.12; e.preventDefault();
  }, { passive: false });
  window.addEventListener('keydown', function (e) {
    if (e.code === 'Space') { running = !running; epStart = null; bestErr = 1e9; e.preventDefault(); }
    if (e.key === 'r' || e.key === 'R') { randomPlace(); }
    if (e.key === 'h' || e.key === 'H') { panel.style.display = panel.style.display === 'none' ? '' : 'none'; }
  });

  function randomPlace() {
    var gc = GameManager.getGameController(); if (!gc) return;
    var mz = gc.getMaze(); if (!mz) return;
    var R = mz.reachable; if (!R || !R.length) return;
    var p = R[Math.floor(Math.random() * R.length)];
    var t = gc.getTank('tank_a');
    if (t) gc.setTankState(TankState.withState('tank_a', p.x*TILE+5, p.y*TILE+5,
        false,false, Math.random()*6.283, false,false,false,false), false);
  }

  // ---------- 虚影渲染 ----------
  function drawGhost() {
    if (!W) resize();
    ctx.clearRect(0, 0, W, H);
    if (!ghost.active) return;
    ctx.save();
    ctx.translate(ghost.x, ghost.y); ctx.rotate(ghost.rot + Math.PI/2);
    ctx.globalAlpha = 0.45;
    ctx.fillStyle = '#00e0a0'; ctx.strokeStyle = '#00ffc0'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.rect(-1.5*TILE, -2*TILE, 3*TILE, 4*TILE); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#7fffd4';
    ctx.beginPath(); ctx.rect(-0.35*TILE, -3.4*TILE, 0.7*TILE, 3.4*TILE); ctx.fill();
    ctx.restore();
    ctx.globalAlpha = 1; ctx.fillStyle = '#0fc';
    ctx.font = '13px monospace';
    ctx.fillText('目标位姿 (' + Math.round(ghost.x) + ',' + Math.round(ghost.y) + ')  ' +
                 (ghost.rot*180/Math.PI).toFixed(0) + '°', ghost.x + 14, ghost.y - 26);
  }

  // ---------- 主循环 ----------
  var acc = 0;
  function step() {
    requestAnimationFrame(step);
    drawGhost();
    var gc = GameManager.getGameController();
    if (!gc) { info.textContent = '等待对局…'; return; }
    var t = gc.getTank('tank_a'); if (!t) { info.textContent = 'tank_a 不在场'; return; }
    var mz = gc.getMaze(); if (!mz) { info.textContent = '迷宫未就绪'; return; }
    if (mapCache === null) buildMap();

    var ax=t.getX(), ay=t.getY(), rot=t.getRotation();
    ghost.active = true;

    if (!running || !weightsLoaded) { return; }

    // 策略决策（每 8 帧一次，省 CPU）
    acc++;
    if (acc % 8 === 0) {
      var o = obsOf(mz, ax, ay, rot, ghost);
      var a = forward(o); if (a !== null) setAct(a);
      epSteps++;
    }

    // 指标
    var dp = Math.sqrt((ghost.x-ax)*(ghost.x-ax) + (ghost.y-ay)*(ghost.y-ay));
    var da = Math.abs(((ghost.rot - rot + Math.PI*3) % (Math.PI*2)) - Math.PI);
    if (dp < bestErr) bestErr = dp;
    var sim = Math.exp(-dp/6.0 - da/0.45);
    info.innerHTML = '车 (' + ax.toFixed(0) + ',' + ay.toFixed(0) + ')  朝向 ' + (rot*180/Math.PI).toFixed(0) + '°<br>' +
      '位置误差 <b style="color:' + (dp<8?'#0f8':'#fc6') + '">' + dp.toFixed(1) + '</b>  角度误差 <b style="color:' +
      (da<0.4?'#0f8':'#fc6') + '">' + (da*180/Math.PI).toFixed(0) + '°</b><br>' +
      '位姿相似度 <b>' + sim.toFixed(3) + '</b>  最优 ' + bestErr.toFixed(1) + '<br>' +
      '状态 ' + (running ? '<b style="color:#0f8">运行中</b>' : '<b style="color:#888">暂停</b>') +
      '  步数 ' + epSteps;
  }

  // 等待游戏就绪
  var wait = setInterval(function () {
    if (typeof GameManager === 'undefined' || !GameManager.getGame) return;
    var g = GameManager.getGame(); if (!g) return;
    if (g.state.current === 'Game' && GameManager.getGameController()) {
      clearInterval(wait);
      resize(); installHook(); buildMap();
      var gc = GameManager.getGameController();
      var t = gc.getTank('tank_a');
      if (t) { ghost.x = t.getX() + 60; ghost.y = t.getY() - 40; }
      info.textContent = '就绪。左键放虚影，空格开始。';
      loadWeights();
      requestAnimationFrame(step);
    }
  }, 500);
  window.addEventListener('resize', resize);
})();
</script>
</body>'''

assert '</body>' in html, 'index.html 没有 </body>'
out = html.replace('</body>', INJECT, 1)
io.open(DST, 'w', encoding='utf-8').write(out)
print('已生成', DST)
print('大小', len(out), '字节（原', len(html), '）')
