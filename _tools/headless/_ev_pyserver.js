'use strict';
/* 启动 / 收尾 game_core/server.py（带 /ajax/ 本地回退的正式本地服务器）
 *
 * 为什么不用简易静态服务器：游戏启动要走 /ajax/ 拿游客账号 + AI 列表，
 * 静态服务器没有这些接口，页面会卡在 Boot。
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const GAME_DIR = process.env.EV_GAME_DIR ? path.resolve(process.env.EV_GAME_DIR) : path.resolve(__dirname, '..', '..', 'game_core');
/* _ev_ 副本：仅把 GAME_DIR 变成可配（供 v167 门冻结副本实验）。其余逐字同 pyserver.js。 */

function startPyServer(opts = {}) {
  return new Promise((resolve, reject) => {
    const exe = opts.python || process.env.PYTHON || 'python';
    const port = opts.port || 8000;
    // ★ 不用管道：某些沙箱环境下 Node 的 spawn 用 stdio:'pipe' 会 EPERM
    //   （已知边界：受限模式下程序无法打开命名管道）。
    //   改成把 python 的 stdout/stderr 重定向到临时文件，然后轮询文件找端口。
    const logFile = path.join(os.tmpdir ? os.tmpdir() : process.env.TEMP || '.',
                              `ttsrv-${process.pid}-${Date.now()}.log`);
    let fd = null;
    try { fd = fs.openSync(logFile, 'w'); } catch (e) { return reject(e); }

    let proc;
    try {
      proc = spawn(exe, ['-u', 'server.py'], {
        cwd: GAME_DIR,
        env: Object.assign({}, process.env, { TT_NO_BROWSER: '1', PYTHONIOENCODING: 'utf-8', VT_PORT: String(port) }),   // ⭐把端口传给 server.py（server.py 读的是 VT_PORT）
        stdio: ['ignore', fd, fd],
        windowsHide: true,
      });
    } catch (e) { try { fs.closeSync(fd); } catch (e2) {} return reject(e); }

    const readPort = () => {
      try {
        const txt = fs.readFileSync(logFile, 'utf8');
        const m = txt.match(/http:\/\/127\.0\.0\.1:(\d+)/);
        return m ? Number(m[1]) : null;
      } catch (e) { return null; }
    };

    let done = false;
    const t0 = Date.now();
    const timer = setInterval(() => {
      if (done) return;
      const pt = readPort();
      if (pt) {
        done = true; clearInterval(timer);
        resolve({
          port: pt,
          origin: `http://127.0.0.1:${pt}`,
          proc,
          logFile,
          log: () => { try { return fs.readFileSync(logFile, 'utf8'); } catch (e) { return ''; } },
          close: () => new Promise((r) => {
            try { proc.kill(); } catch (e) {}
            try { fs.closeSync(fd); } catch (e) {}
            try { fs.unlinkSync(logFile); } catch (e) {}
            setTimeout(r, 150);
          }),
        });
        return;
      }
      if (Date.now() - t0 > (opts.timeoutMs || 25000)) {
        done = true; clearInterval(timer);
        let txt = '';
        try { txt = fs.readFileSync(logFile, 'utf8'); } catch (e) {}
        try { proc.kill(); } catch (e) {}
        reject(new Error('server.py 启动超时:\n' + txt.slice(-2000)));
      }
    }, 200);

    proc.on('error', (e) => { if (!done) { done = true; clearInterval(timer); reject(e); } });
    proc.on('exit', (code) => {
      if (!done) {
        done = true; clearInterval(timer);
        let txt = ''; try { txt = fs.readFileSync(logFile, 'utf8'); } catch (e) {}
        reject(new Error('server.py 退出 code=' + code + '\n' + txt.slice(-2000)));
      }
    });
  });
}

module.exports = { startPyServer, GAME_DIR };
