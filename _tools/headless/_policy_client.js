// 共用策略服务端客户端：按行缓冲（一个 data 块可能含多行/半行 ⟹ ⛔ 不许 once('data') 直接解析）
function makeAsk(proc) {
  let buf = '';
  const queue = [];      // 已到达但还没人取的回包
  const waiting = [];    // 已发出但还没回包的 resolve
  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      let obj;
      try { obj = JSON.parse(line); } catch (e) { obj = { err: 'parse:' + line.slice(0, 80) }; }
      const r = waiting.shift();
      if (r) r(obj); else queue.push(obj);
    }
  });
  return function ask(payload) {
    return new Promise((resolve) => {
      const ready = queue.shift();
      waiting.push(resolve);
      proc.stdin.write(JSON.stringify(payload) + '\n');
      if (ready) { const r = waiting.pop(); r(ready); }   // 已有排队回包：立刻兑现（顺序仍对）
    });
  };
}
module.exports = { makeAsk };
