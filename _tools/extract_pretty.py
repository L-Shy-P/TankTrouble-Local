# -*- coding: utf-8 -*-
"""只读工具：把 game_core/js 下 mod_pagespeed 包装的单行模块解包 + 美化，输出到临时目录供 grep。
不修改任何代码文件（只读源文件，只写临时目录）。"""
import sys, os, re, json
import jsbeautifier

OUT = os.environ.get("PRETTY_OUT", os.path.join(os.environ.get("TEMP", "."), "tt", "pretty"))
os.makedirs(OUT, exist_ok=True)

BS = chr(92)  # backslash


def unesc(s):
    out = []
    i = 0
    n = len(s)
    while i < n:
        c = s[i]
        if c == BS and i + 1 < n:
            d = s[i + 1]
            if d == 'n':
                out.append(chr(10)); i += 2; continue
            if d == 't':
                out.append(chr(9)); i += 2; continue
            if d == 'r':
                out.append(chr(13)); i += 2; continue
            if d in ('"', "'", BS):
                out.append(d); i += 2; continue
            if d == 'u':
                try:
                    out.append(chr(int(s[i + 2:i + 6], 16))); i += 6; continue
                except ValueError:
                    pass
            if d == 'x':
                try:
                    out.append(chr(int(s[i + 2:i + 4], 16))); i += 4; continue
                except ValueError:
                    pass
            out.append(d); i += 2; continue
        out.append(c); i += 1
    return ''.join(out)


def extract(line):
    m = re.match(r'^\s*var\s+(mod_pagespeed_\S+)\s*=\s*"', line)
    if not m:
        return None, None
    body = line[m.end():].rstrip()
    if body.endswith('";'):
        body = body[:-2]
    elif body.endswith('"'):
        body = body[:-1]
    return m.group(1), unesc(body)


def guess_module(src):
    exp = re.findall(r"module\.exports=([A-Za-z0-9_$.]+);", src)
    names = re.findall(r"\.name\('([A-Za-z0-9_]+)'\)", src)
    return (exp[0].split('.')[-1] if exp else (names[0] if names else '?'))


def main(paths):
    opts = jsbeautifier.default_options(); opts.indent_size = 2; opts.wrap_line_length = 0
    index = []
    for p in paths:
        base = os.path.basename(p)
        lines = open(p, encoding='utf-8', errors='replace').read().split('\n')
        for n, line in enumerate(lines, 1):
            var, src = extract(line)
            if src is None:
                print("!! %s:%d not wrapped (%d chars)" % (base, n, len(line)))
                continue
            mod = guess_module(src)
            pretty = jsbeautifier.beautify(src, opts)
            safe = re.sub(r'[^A-Za-z0-9_.$-]', '_', mod)
            o = os.path.join(OUT, "%s__L%d__%s.pretty.js" % (base, n, safe))
            open(o, 'w', encoding='utf-8').write(pretty)
            index.append(dict(file=base, line=n, module=mod, src_chars=len(src),
                              pretty_lines=len(pretty.split(chr(10))), out=o))
    json.dump(index, open(os.path.join(OUT, "_index.json"), 'w', encoding='utf-8'),
              indent=1, ensure_ascii=False)
    for e in index:
        print("%s:%d\t%s\tsrc=%d\tpretty=%d" % (e['file'], e['line'], e['module'], e['src_chars'], e['pretty_lines']))


if __name__ == '__main__':
    main(sys.argv[1:])
