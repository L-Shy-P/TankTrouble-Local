'use strict';
/* 极简静态服务器 —— 只为了给无头浏览器一个 http:// 源（file:// 下 worker/fetch 会被拦） */
const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.txt': 'text/plain; charset=utf-8',
  '.gz': 'application/gzip',
  '.bin': 'application/octet-stream',
  '.ttf': 'font/ttf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

function startServer(root, port = 0) {
  root = path.resolve(root);
  const server = http.createServer((req, res) => {
    let p;
    try { p = decodeURIComponent(url.parse(req.url).pathname); } catch (e) { p = '/'; }
    if (p.endsWith('/')) p += 'index.html';
    const full = path.join(root, p);
    // 防目录穿越
    if (!full.startsWith(root)) { res.writeHead(403); return res.end('forbidden'); }
    fs.stat(full, (err, st) => {
      if (err || !st.isFile()) { res.writeHead(404); return res.end('not found: ' + p); }
      const type = MIME[path.extname(full).toLowerCase()] || 'application/octet-stream';
      res.writeHead(200, {
        'Content-Type': type,
        'Content-Length': st.size,
        'Cache-Control': 'no-store',
        // 让 SharedArrayBuffer / 高精度计时器可用（如果将来要测性能）
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'require-corp',
      });
      fs.createReadStream(full).pipe(res);
    });
  });
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address();
      resolve({
        port: addr.port,
        origin: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise((r) => server.close(r)),
        raw: server,
      });
    });
  });
}

module.exports = { startServer };

if (require.main === module) {
  const root = process.argv[2] || '.';
  const port = Number(process.argv[3] || 8791);
  startServer(root, port).then((s) => console.log('serving', root, 'at', s.origin));
}
