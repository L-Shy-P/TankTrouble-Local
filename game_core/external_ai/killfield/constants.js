/**
 * 我们的常量表：喂给从 killfield-main 拷贝过来的算法（field.js 等）。
 * ---------------------------------------------------------------------------
 * 他们只依赖很少几个常量，但要按**我们游戏的量纲**折算：
 *   · 他们的代码里 `speed = C.BULLETSPEED * (scale / 50)`（世界单位/帧），
 *     并且 `DEFAULT_FLIGHT_FRAMES = 3 * C.FPS`（帧）。
 *   · 所以我们的 BULLETSPEED 取"每帧弹速 × (50 / 格子尺寸)"，
 *     FPS 取**我们**的帧率，这样"三秒内的子弹才算数"这条语义才对得上。
 */
'use strict';

const CFG = {
    FPS: 50,                 // 我们对局物理帧率（FRAME_DT = 0.02s）
    TILE_M: 10,              // 迷宫一格的世界尺寸（米）
    BULLET_SPEED_MPS: 20,    // 子弹速度（米/秒）
    MAX_BULLETS: 5           // 一辆车同时最多几发（我们和他们都一样）
};

/** 从游戏里的 Constants 覆盖默认值（拿不到就沿用默认）。 */
function applyGameConstants(constants) {
    try {
        if (!constants) return;
        if (constants.MAZE_TILE_SIZE && constants.MAZE_TILE_SIZE.m) CFG.TILE_M = constants.MAZE_TILE_SIZE.m;
        if (constants.BULLET && constants.BULLET.SPEED && constants.BULLET.SPEED.m) {
            CFG.BULLET_SPEED_MPS = constants.BULLET.SPEED.m;
        }
        if (constants.TANK && constants.TANK.MAX_BULLETS) CFG.MAX_BULLETS = constants.TANK.MAX_BULLETS;
    } catch (e) { /* 拿不到就用默认 */ }
}

applyGameConstants(typeof Constants !== 'undefined' ? Constants : null);

export const FPS = CFG.FPS;
export let BULLETSPEED = (CFG.BULLET_SPEED_MPS / CFG.FPS) * (50 / CFG.TILE_M);
export let SETTINGS_MAX_BULLETS = CFG.MAX_BULLETS;
export const DEG = Math.PI / 180;
export const NUMBEROFFRAMESFROZEN = 0;
// 他们的引擎里弹速是按子步存的，所以要乘子步数；我们的视图直接把弹速折算成
// **每帧**（米/帧），因此这里必须是 1。
export const BULLETHITCHECKINTERVALS = 1;

/** 供接线/测试用：按给定游戏常量重算量纲。 */
export function refreshFromConstants(constants) {
    applyGameConstants(constants);
    BULLETSPEED = (CFG.BULLET_SPEED_MPS / CFG.FPS) * (50 / CFG.TILE_M);
    SETTINGS_MAX_BULLETS = CFG.MAX_BULLETS;
    return units();
}

export function units() {
    return {
        FPS: CFG.FPS,
        BULLETSPEED: BULLETSPEED,
        TILE_M: CFG.TILE_M,
        BULLET_SPEED_MPS: CFG.BULLET_SPEED_MPS,
        MAX_BULLETS: CFG.MAX_BULLETS
    };
}
