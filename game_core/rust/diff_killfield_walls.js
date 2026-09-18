#!/usr/bin/env node
// Killfield 墙语义回归：K 的寻路图必须与游戏自身 BFS 的"墙挡路"规则**逐格一致**。
//
// 背景（主人实测：K 开局撞墙、甚至开局撞墙自杀）：
//   K 原来只按 maze.isPositionInsideMaze(...) 建格子图，**从不查墙标志**，
//   所以 BFS 会径直穿过两格之间的墙，AI 就一路顶着墙开。
//
// 权威规则（逐字摘自游戏源码 Maze._traverseCloseTiles / Maze._createGraph）：
//   能否往左 (x-1,y): tiles[x][y][2]   === 0
//   能否往右 (x+1,y): tiles[x+1][y][2] === 0
//   能否往上 (x,y-1): tiles[x][y][1]   === 0
//   能否往下 (x,y+1): tiles[x][y+1][1] === 0
//   且 tiles[x][y][0] === 1 表示"这一格存在"
// 下面是**独立重写**的参考实现，用于和 K 的 buildGameViewFromTiles 对拍。
'use strict';
const path = require('path');
const assert = require('assert');
const { pathToFileURL } = require('url');
const dir = path.resolve(__dirname, '..', 'external_ai', 'killfield');
const TILE = 10;
const WALL = 0.8;                       // Constants.MAZE_WALL_WIDTH.m = 16/20

// ---- 造一个 5x3 的迷宫：第 2 列左边在两行有墙，只在最后一行留缺口 ----
// tiles[i][j] = [ 格存在?, 上墙?, 左墙? ]
function makeTiles() {
    const W = 5, H = 3;
    const tiles = [];
    for (let i = 0; i < W; i++) {
        tiles[i] = [];
        for (let j = 0; j < H; j++) tiles[i][j] = [1, 0, 0];
    }
    tiles[2][0][2] = 1;                 // 格(2,0) 左墙 → 挡住 (1,0)<->(2,0)
    tiles[2][1][2] = 1;                 // 格(2,1) 左墙 → 挡住 (1,1)<->(2,1)
    // 格(2,2) 左墙 = 0 → (1,2)<->(2,2) 通（唯一缺口）
    return tiles;
}

function makeMaze(tiles) {
    return {
        getTiles: () => tiles,
        getWidth: () => tiles.length,
        getHeight: () => tiles[0].length,
        isPositionInsideMaze: (p) => {
            if (p.x < 0 || p.y < 0 || p.x >= tiles.length || p.y >= tiles[0].length) return false;
            return tiles[p.x][p.y][0] === 1;
        }
    };
}

// ---- 参考实现：逐字照抄游戏规则 ----
function refCanGo(tiles, x, y, nx, ny) {
    const W = tiles.length, H = tiles[0].length;
    if (nx < 0 || ny < 0 || nx >= W || ny >= H) return false;
    if (tiles[nx][ny][0] !== 1) return false;
    if (nx === x - 1 && ny === y) return tiles[x][y][2] === 0;
    if (nx === x + 1 && ny === y) return tiles[x + 1][y][2] === 0;
    if (nx === x && ny === y - 1) return tiles[x][y][1] === 0;
    if (nx === x && ny === y + 1) return tiles[x][y + 1][1] === 0;
    return false;
}

function refDistMap(tiles, sx, sy) {
    const W = tiles.length, H = tiles[0].length;
    const dist = [];
    for (let i = 0; i < W; i++) dist[i] = new Array(H).fill(null);
    if (tiles[sx][sy][0] !== 1) return dist;
    dist[sx][sy] = 0;
    const q = [[sx, sy]];
    for (let head = 0; head < q.length; head++) {
        const [x, y] = q[head];
        const nb = [[x, y - 1], [x + 1, y], [x, y + 1], [x - 1, y]];
        for (const [nx, ny] of nb) {
            if (dist[nx] === undefined || dist[nx][ny] !== null) continue;
            if (!refCanGo(tiles, x, y, nx, ny)) continue;
            dist[nx][ny] = dist[x][y] + 1;
            q.push([nx, ny]);
        }
    }
    return dist;
}

// ---- 旧写法（故障版）：只看格子在不在，不看墙 ----
function blindDistMap(tiles, sx, sy) {
    const W = tiles.length, H = tiles[0].length;
    const dist = [];
    for (let i = 0; i < W; i++) dist[i] = new Array(H).fill(null);
    dist[sx][sy] = 0;
    const q = [[sx, sy]];
    for (let head = 0; head < q.length; head++) {
        const [x, y] = q[head];
        const nb = [[x, y - 1], [x + 1, y], [x, y + 1], [x - 1, y]];
        for (const [nx, ny] of nb) {
            if (dist[nx] === undefined || dist[nx][ny] !== null) continue;
            if (tiles[nx][ny][0] !== 1) continue;
            dist[nx][ny] = dist[x][y] + 1;
            q.push([nx, ny]);
        }
    }
    return dist;
}

(async function main() {
    const mod = await import(pathToFileURL(path.join(dir, 'gameView.js')).href);
    assert.ok(typeof mod.buildGameViewFromTiles === 'function', '缺少 buildGameViewFromTiles');

    const tiles = makeTiles();
    const maze = makeMaze(tiles);
    const view = mod.buildGameViewFromTiles(maze, { tileM: TILE, wallWidth: WALL });
    assert.ok(view, 'buildGameViewFromTiles 返回空');

    // 1) 墙盒几何：0.8 米厚、贴在格边界上
    const vert = view.walls.filter(b => Math.abs(b[0] - (2 * TILE - WALL / 2)) < 1e-9 && b[2] - b[0] < 2);
    assert.ok(vert.length === 2, '格(2,0)/(2,1) 应各有一堵竖墙，实际 ' + vert.length);
    assert.ok(Math.abs((vert[0][2] - vert[0][0]) - WALL) < 1e-9, '墙厚应为 ' + WALL);
    assert.ok(Math.abs(vert[0][0] - (2 * TILE - WALL / 2)) < 1e-9, '竖墙应贴 x=2*tile 边界');
    assert.ok(Math.abs(vert[0][3] - vert[0][1] - (TILE + WALL)) < 1e-9, '竖墙应贯穿一格');

    // 2) 权威邻接：墙挡住、缺口通
    assert.strictEqual(view.canGo(1, 0, 2, 0), false, '有墙的两格竟然算通（穿墙）');
    assert.strictEqual(view.canGo(2, 0, 1, 0), false, '反向也应被挡');
    assert.strictEqual(view.canGo(1, 1, 2, 1), false, '有墙的两格竟然算通（穿墙）');
    assert.strictEqual(view.canGo(1, 2, 2, 2), true, '缺口应可通行');
    assert.strictEqual(view.canGo(2, 2, 1, 2), true, '缺口反向应可通行');

    // 3) 距离场：K 的 BFS 必须等于参考实现（逐格）
    for (const start of [[0, 0], [4, 2], [2, 1]]) {
        const mine = view.distMap(start[0], start[1]);
        const ref = refDistMap(tiles, start[0], start[1]);
        for (let i = 0; i < tiles.length; i++) {
            for (let j = 0; j < tiles[0].length; j++) {
                assert.strictEqual(mine[i][j], ref[i][j],
                    `距离场不符 @起点(${start}) 格(${i},${j})：K=${mine[i][j]} 参考=${ref[i][j]}`);
            }
        }
    }

    // 4) 守护断言：**旧写法必然穿墙**（这条保证"修好了"不会被误判成"本来就是对的"）
    const blind = blindDistMap(tiles, 0, 0);
    assert.strictEqual(blind[2][0], 2, '旧写法本应直接穿过墙（2 步到 (2,0)）');
    // 绕墙唯一通道在最下一行：(0,0)→(0,1)→(0,2)→(1,2)→(2,2)→(2,1)→(2,0) = 6 步
    assert.strictEqual(view.distMap(0, 0)[2][0], 6, 'K 现在必须绕过墙（6 步到 (2,0)）');
    assert.notStrictEqual(blind[2][0], view.distMap(0, 0)[2][0],
        '守护断言失效：新旧距离相同，说明本例没能体现穿墙');

    console.log('PASS：墙盒 0.8 米贴边界 ＋ 权威邻接挡墙/留缺口 ＋ 距离场逐格等于游戏规则 ＋ 旧写法穿墙（守护）');
})().catch(e => { console.error('FAIL：' + (e && e.message)); process.exit(1); });
