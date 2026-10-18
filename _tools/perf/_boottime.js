const { spawn } = require('child_process');
const t0 = Date.now();
const p = spawn('py', ['-3.13', '_tools/training/policy_server_graph.py'], { cwd: process.cwd(), env: Object.assign({}, process.env, { PYTHONIOENCODING: 'utf-8', VT_CKPT: 'D:/vt_run/cyc_1/ckpt/model_latest.pt' }) });
p.stdout.setEncoding('utf8');
let buf = '';
p.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); console.log(((Date.now() - t0) / 1000).toFixed(2) + 's  ' + l.slice(0, 120)); } });
p.stderr.setEncoding('utf8');
p.stderr.on('data', (d) => String(d).split('\n').forEach((l) => { if (l.trim()) console.log(((Date.now() - t0) / 1000).toFixed(2) + 's E ' + l.slice(0, 160)); }));
setTimeout(() => { p.kill(); process.exit(0); }, 240000);
