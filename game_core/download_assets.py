# -*- coding: utf-8 -*-
"""扫描并下载所有缺失的游戏资源"""
import os, re, requests, time

GAME_CORE = os.path.join(os.path.dirname(os.path.abspath(__file__)))
CDN_BASE = 'https://cdn.tanktrouble.com/RELEASE-2026-05-11-01/'

def scan_assets():
    """扫描所有JS/CSS/HTML中引用的资源路径"""
    asset_paths = set()

    # 扫描JS文件
    js_dir = os.path.join(GAME_CORE, 'js')
    for fname in os.listdir(js_dir):
        fpath = os.path.join(js_dir, fname)
        if not os.path.isfile(fpath):
            continue
        with open(fpath, 'r', encoding='utf-8', errors='replace') as f:
            content = f.read()
        # g_url('assets/...')
        for m in re.finditer(r"g_url\(['\"]([^'\"]+)['\"]\)", content):
            asset_paths.add(m.group(1))
        # 'assets/xxx.ext'
        for m in re.finditer(r"['\"](assets/[^'\"]+\.(png|jpg|svg|json|m4a|mp3|ogg|wav))['\"]", content):
            asset_paths.add(m.group(1))

    # 扫描CSS文件
    css_dir = os.path.join(GAME_CORE, 'css')
    if os.path.exists(css_dir):
        for fname in os.listdir(css_dir):
            fpath = os.path.join(css_dir, fname)
            if not os.path.isfile(fpath):
                continue
            with open(fpath, 'r', encoding='utf-8', errors='replace') as f:
                content = f.read()
            for m in re.finditer(r"url\(['\"]?([^'\")]+)['\"]?\)", content):
                p = m.group(1)
                if p.startswith('assets/'):
                    asset_paths.add(p)

    # 扫描index.html
    html_path = os.path.join(GAME_CORE, 'index.html')
    with open(html_path, 'r', encoding='utf-8') as f:
        html = f.read()
    for m in re.finditer(r"src=['\"]([^'\"]+assets/[^'\"]+)['\"]", html):
        asset_paths.add(m.group(1))
    for m in re.finditer(r"srcset=['\"]([^'\"]+)['\"]", html):
        for part in m.group(1).split(','):
            p = part.strip().split()[0]
            asset_paths.add(p)

    return asset_paths

def download_missing(asset_paths):
    """下载缺失的资源"""
    missing = []
    for p in sorted(asset_paths):
        local = os.path.join(GAME_CORE, p.replace('/', os.sep))
        if not os.path.exists(local):
            missing.append(p)

    print(f'Total referenced: {len(asset_paths)}')
    print(f'Missing: {len(missing)}')

    ok = 0
    fail = 0
    for i, p in enumerate(missing):
        url = CDN_BASE + p
        local = os.path.join(GAME_CORE, p.replace('/', os.sep))
        os.makedirs(os.path.dirname(local), exist_ok=True)
        try:
            r = requests.get(url, headers={'User-Agent': 'Mozilla/5.0'}, timeout=15)
            if r.status_code == 200:
                with open(local, 'wb') as f:
                    f.write(r.content)
                ok += 1
                print(f'  [{ok}/{len(missing)}] OK {p} ({len(r.content)} bytes)')
            else:
                fail += 1
                print(f'  [{i+1}/{len(missing)}] FAIL {p} -> {r.status_code}')
        except Exception as e:
            fail += 1
            print(f'  [{i+1}/{len(missing)}] ERR {p} -> {e}')
        time.sleep(0.05)  # 避免请求过快

    print(f'\nDone! OK: {ok}, Fail: {fail}')

if __name__ == '__main__':
    assets = scan_assets()
    download_missing(assets)
