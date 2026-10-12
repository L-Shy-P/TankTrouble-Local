/**
 * Vantage × FlyWire · 局面桥（游戏侧，只读）
 * ==========================================================================
 * 作用：把当前对局的**只读快照**写到 localStorage，供 flywire_debug.html 读取。
 *
 * ⚠️ 本文件**不产生任何决策、不写任何输入、不影响对局**。
 *    它只读 gameController，然后往 localStorage 写一段 JSON。
 *
 * 为什么要走 localStorage 而不是直接调用：
 *    调试页是**独立标签页**，拿不到游戏里的 JS 对象。同源标签页之间只能靠
 *    localStorage / BroadcastChannel 传数据。读快照、不写游戏，这样最安全。
 *
 * 打开方式：
 *    1) 先开游戏（启动游戏.bat）并进入一局
 *    2) 再另开一个标签页访问 http://127.0.0.1:8000/flywire_debug.html
 */
(function (global) {
    'use strict';

    var KEY = 'vantageFlySnapshot';
    global.__flyLatestSnapshot = null;   // 同页直连：嵌在同一标签页里时，调试页直接读它（零延迟、不受限流影响）
    var HZ = 15;                 // 写快照频率（Hz）——localStorage 是同步 API，别写太频
    var lastWrite = 0;
    var warned = false;

    /** 从全局 AIs 里找一个带 gameController 的 manager（照 vantage_testbench 的路子）。 */
    function findGame() {
        if (typeof AIs === 'undefined' || !AIs.aiManagers) return null;
        for (var i = 0; i < AIs.aiManagers.length; i++) {
            var m = AIs.aiManagers[i];
            if (m && m.gameController) return { gc: m.gameController, aiId: String(m.aiId) };
        }
        return null;
    }

    function num(v) { return (typeof v === 'number' && isFinite(v)) ? v : 0; }

    /** 取一辆坦克的安全数值快照。 */
    function tankSnap(t, id) {
        if (!t) return null;
        var o = { id: String(id), x: num(t.getX && t.getX()), y: num(t.getY && t.getY()),
                  rot: num(t.getRotation && t.getRotation()) };
        try {
            var body = t.getB2DBody ? t.getB2DBody() : null;
            if (body && body.GetLinearVelocity) {
                var lv = body.GetLinearVelocity();
                o.vx = num(lv.x); o.vy = num(lv.y);
            }
        } catch (e) { /* 拿不到速度就算了，不是关键字段 */ }
        return o;
    }

    function buildSnapshot(gc, aiId) {
        var tanks = [], bullets = [], k;
        try {
            var ts = gc.getTanks ? gc.getTanks() : null;
            for (k in ts) if (ts.hasOwnProperty(k)) {
                var s = tankSnap(ts[k], k);
                if (s) { s.isAI = (String(k) === aiId); tanks.push(s); }
            }
        } catch (e1) {}
        try {
            var ps = gc.getProjectiles ? gc.getProjectiles() : null;
            for (k in ps) if (ps.hasOwnProperty(k)) {
                var p = ps[k];
                if (!p) continue;
                bullets.push({
                    x: num(p.getX && p.getX()), y: num(p.getY && p.getY()),
                    vx: num(p.getSpeedX && p.getSpeedX()), vy: num(p.getSpeedY && p.getSpeedY())
                });
            }
        } catch (e2) {}
        return { t: Date.now(), aiId: aiId, tanks: tanks, bullets: bullets };
    }

    function tick() {
        var now = Date.now();
        var found = findGame();
        if (!found) {
            if (!warned) { warned = true; console.log('[FlyBridge] 还没找到 gameController（可能不在对局中）。'); }
            return;
        }
        var gc = found.gc, snap = buildSnapshot(gc, found.aiId);
        // ★ 同页直连【每帧】更新（零成本，调试页才可能真正实时）
        global.__flyLatestSnapshot = snap;
        try { global.parent.__flyLatestSnapshot = snap; } catch (e) {}
        // localStorage 只做兜底，仍限频（那是同步 IO，不能每帧写）
        if (now - lastWrite < 1000 / HZ) return;
        lastWrite = now;
        try {
            global.localStorage.setItem(KEY, JSON.stringify(snap));
        } catch (e) {
            // localStorage 写满或被禁用：只报一次，不打断游戏
            if (!warned) { warned = true; console.warn('[FlyBridge] 写快照失败:', e); }
        }
    }

    // 挂到游戏主循环上（有 requestAnimationFrame 就用它，否则退化成定时器）
    var raf = global.requestAnimationFrame || function (cb) { return setTimeout(cb, 66); };
    function loop() { tick(); raf(loop); }
    loop();

    console.log('[FlyBridge] 局面桥已启动（只读，' + HZ + 'Hz，写 localStorage["' + KEY + '"]）');
})(typeof window !== 'undefined' ? window : this);
