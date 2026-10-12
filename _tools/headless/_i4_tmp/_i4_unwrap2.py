"""_i4_ : unwrap long-string-wrapped modules in game_core/js and beautify them.
Read-only for game_core/; writes only into _tools/headless/_i4_tmp/."""
import jsbeautifier, os

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
SRC = os.path.join(ROOT, 'game_core', 'js')
OUT = os.path.join(ROOT, '_tools', 'headless', '_i4_tmp')

BS = chr(92)
MP = {'n': chr(10), 't': chr(9), 'r': chr(13), '"': '"', "'": "'",
      BS: BS, '/': '/', 'b': chr(8), 'f': chr(12), '0': chr(0)}


def unescape_js(body):
    out = []
    i = 0
    n = len(body)
    while i < n:
        c = body[i]
        if c == BS and i + 1 < n:
            d = body[i + 1]
            if d in MP:
                out.append(MP[d]); i += 2; continue
            if d == 'u':
                out.append(chr(int(body[i + 2:i + 6], 16))); i += 6; continue
            if d == 'x':
                out.append(chr(int(body[i + 2:i + 4], 16))); i += 4; continue
            if d == 'n':
                i += 2; continue
            out.append(d); i += 2; continue
        out.append(c); i += 1
    return ''.join(out)


def extract_literals(s):
    res = []
    i = 0
    n = len(s)
    while i < n:
        if s[i] == '"':
            j = i + 1
            buf = []
            while j < n:
                c = s[j]
                if c == BS and j + 1 < n:
                    buf.append(c); buf.append(s[j + 1]); j += 2; continue
                if c == '"':
                    break
                buf.append(c); j += 1
            raw = ''.join(buf)
            if len(raw) >= 300 and ('function' in raw or 'var ' in raw):
                res.append(unescape_js(raw))
            i = j + 1
            continue
        i += 1
    return res


def dump(src, dst, indent=1):
    s = open(src, encoding='utf-8', errors='replace').read()
    bodies = extract_literals(s)
    if not bodies:
        bodies = [s]
    body = (chr(10) + ';' + chr(10)).join(bodies)
    opts = jsbeautifier.default_options()
    opts.indent_size = indent
    out = jsbeautifier.beautify(body, opts)
    open(dst, 'w', encoding='utf-8').write(out)
    print(os.path.basename(dst), len(out.split(chr(10))), 'lines,', len(bodies), 'modules')


FILES = [
    ('7b2ed8ad3598d7321f8f3d2b04b1eac8', '_i4_game_entities'),
    ('418577fd210ad079ea3d1e5e04050fe0', '_i4_game_projectile'),
    ('54518faa8d672020d7af8ed7c353bc1b', '_i4_game_messages'),
    ('b714588dc4621fe104113111ba90b1a7', '_i4_game_constants'),
    ('82e43ebfcdffdaf490dbe79c9c119d29', '_i4_game_roundcontroller'),
    ('46989e393ad0e356ac8a0c6c53b362f9', '_i4_game_roundmodel'),
    ('5b69cfb31c3adc4ccd413cbeead0663c', '_i4_game_ai'),
]

if __name__ == '__main__':
    for a, b in FILES:
        dump(os.path.join(SRC, a + '.js'), os.path.join(OUT, b + '.js'))
