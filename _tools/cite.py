# -*- coding: utf-8 -*-
"""只读工具：验证引用片段在原始（压缩）文件中的物理行号 + 字符偏移。
用法：python _tools/cite.py 文件 片段 [片段...]
或：  python _tools/cite.py --file 文件   （从 stdin 逐行读片段）
"""
import sys, io, os

def find(path, snippet):
    with io.open(path, encoding='utf-8', errors='replace') as f:
        data = f.read()
    idx = data.find(snippet)
    if idx < 0:
        return None
    line = data.count(chr(10), 0, idx) + 1
    line_start = data.rfind(chr(10), 0, idx) + 1
    col = idx - line_start
    return dict(line=line, col=col, char=idx)

def main():
    args = sys.argv[1:]
    if args and args[0] == '--file':
        path = args[1]
        snippets = [l.rstrip(chr(10)) for l in sys.stdin if l.strip()]
    else:
        path = args[0]
        snippets = args[1:]
    for s in snippets:
        r = find(path, s)
        if r is None:
            print('MISS  | %s | %s' % (path, s[:70]))
        else:
            print('行%-3d 字符偏移%-8d | %s | %s' % (r['line'], r['char'], os.path.basename(path), s[:70]))

if __name__ == '__main__':
    main()
