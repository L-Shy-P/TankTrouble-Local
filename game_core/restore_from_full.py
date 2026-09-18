# -*- coding: utf-8 -*-
"""
对比完整版游戏与 game_core，程序化恢复缺失资源与 JS 模块。

用法:
  python restore_from_full.py              # 扫描并下载缺失资源
  python restore_from_full.py --check-js   # 对比 original_js 与本地 JS 完整性
  python restore_from_full.py --all        # 全部执行
"""
import os
import re
import sys
import time
import hashlib
import argparse
import urllib.request

if sys.platform == 'win32':
    sys.stdout.reconfigure(encoding='utf-8')
    sys.stderr.reconfigure(encoding='utf-8')

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
CACHE_DIR = os.path.join(BASE_DIR, '..', 'cache')
ORIGINAL_JS_DIR = os.path.join(BASE_DIR, 'original_js')
LOCAL_JS_DIR = os.path.join(BASE_DIR, 'js')
CDN_BASE = 'https://cdn.tanktrouble.com/RELEASE-2026-05-11-01/'

# JS 中动态拼接、scan_assets 扫不到的已知资源
KNOWN_DYNAMIC_ASSETS = []
for _set in ('WASDKeys', 'arrowKeys', 'mouse'):
    for _suffix in ('', 'Down', 'Active', 'Selected'):
        KNOWN_DYNAMIC_ASSETS.append(f'assets/images/inputs/{_set}{_suffix}.png')
        KNOWN_DYNAMIC_ASSETS.append(f'assets/images/inputs/{_set}{_suffix}@2x.png')

# 关键游戏模块（来自 original_js 文件名）
CRITICAL_MODULES = [
    'ais.js', 'aimanager.js', 'ai.js', 'aiutils.js',
    'backend.js', 'ajax.js',
    'uimenustate.js', 'uilobbystate.js', 'uigamestate.js',
    'adduserbox.js', 'selectuserbox.js',
    'gamecontroller.js', 'gamemodel.js', 'roundcontroller.js',
    'player.js', 'constants.js',
]


def scan_assets():
    """扫描 JS/CSS/HTML 中引用的 assets/ 路径"""
    asset_paths = set(KNOWN_DYNAMIC_ASSETS)

    def add_from_content(content):
        for m in re.finditer(r"g_url\(['\"]([^'\"]+)['\"]\)", content):
            if m.group(1).startswith('assets/'):
                asset_paths.add(m.group(1))
        for m in re.finditer(r"['\"](assets/[^'\"]+\.(?:png|jpg|svg|json|m4a|mp3|ogg|wav|atlas))['\"]", content):
            asset_paths.add(m.group(1))

    for sub in ('js', 'css'):
        d = os.path.join(BASE_DIR, sub)
        if not os.path.isdir(d):
            continue
        for fname in os.listdir(d):
            fpath = os.path.join(d, fname)
            if os.path.isfile(fpath):
                with open(fpath, 'r', encoding='utf-8', errors='replace') as f:
                    add_from_content(f.read())

    html_path = os.path.join(BASE_DIR, 'index.html')
    if os.path.exists(html_path):
        with open(html_path, 'r', encoding='utf-8') as f:
            html = f.read()
        for m in re.finditer(r"(?:src|href)=['\"]([^'\"]+assets/[^'\"]+)['\"]", html):
            asset_paths.add(m.group(1))
        for m in re.finditer(r"srcset=['\"]([^'\"]+)['\"]", html):
            for part in m.group(1).split(','):
                p = part.strip().split()[0]
                if p.startswith('assets/'):
                    asset_paths.add(p)

    return asset_paths


def download_url(url, local_path):
    os.makedirs(os.path.dirname(local_path), exist_ok=True)
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    with urllib.request.urlopen(req, timeout=20) as resp:
        data = resp.read()
    with open(local_path, 'wb') as f:
        f.write(data)
    return len(data)


def restore_assets():
    """下载 game_core 缺失的资源文件"""
    asset_paths = scan_assets()
    missing = [p for p in sorted(asset_paths)
               if not os.path.exists(os.path.join(BASE_DIR, p.replace('/', os.sep)))]

    print(f'[资源] 引用 {len(asset_paths)} 个, 缺失 {len(missing)} 个')
    ok = fail = 0
    for p in missing:
        url = CDN_BASE + p
        local = os.path.join(BASE_DIR, p.replace('/', os.sep))
        try:
            size = download_url(url, local)
            ok += 1
            print(f'  [OK] {p} ({size} bytes)')
        except Exception as e:
            fail += 1
            print(f'  [FAIL] {p}: {e}')
        time.sleep(0.05)
    print(f'[资源] 完成: 下载 {ok}, 失败 {fail}')
    return fail == 0


def extract_mod_vars(js_dir):
    """提取所有 mod_pagespeed 变量内容"""
    vars_map = {}
    if not os.path.isdir(js_dir):
        return vars_map
    for fname in os.listdir(js_dir):
        if not fname.endswith('.js'):
            continue
        fpath = os.path.join(js_dir, fname)
        with open(fpath, 'r', encoding='utf-8', errors='ignore') as f:
            content = f.read()
        for m in re.finditer(r'var (mod_pagespeed_\S+)\s*=\s*"((?:[^"\\]|\\.)*)"', content):
            var_name = m.group(1)
            var_value = m.group(2).replace('\\"', '"').replace('\\n', '\n')
            vars_map[var_name] = var_value
    return vars_map


def check_js_integrity():
    """对比 original_js 与本地 js 中的关键代码片段"""
    print('[JS] 对比 original_js 与本地 js ...')

    local_vars = extract_mod_vars(LOCAL_JS_DIR)
    local_blob = '\n'.join(local_vars.values())

    missing_snippets = []
    found_snippets = []

    checks = [
        ('AIs.init', 'AIs.classMethods'),
        ('AIManager.update', 'AIManager.methods'),
        ('AI.update', 'AI.methods'),
        ('createGuests', 'playerDetails'),
        ('ControlsOverlay', 'assets/images/inputs/'),
        ('createLocalGame', 'AIs.addAIManager'),
        ('Inputs.getAllInputSetIds', 'WASDKeys'),
        ('Backend.getInstance', 'createGuests'),
        ('TankTrouble.Ajax._call', 'account.createGuests'),
    ]

    for label, needle in checks:
        if needle in local_blob:
            found_snippets.append(label)
        else:
            missing_snippets.append((label, needle))

    print(f'  本地 mod_pagespeed 变量: {len(local_vars)} 个')
    for label in found_snippets:
        print(f'  [OK] {label}')
    for label, needle in missing_snippets:
        print(f'  [MISSING] {label} (未找到: {needle})')

    # 对比 original_js 文件是否能在本地找到对应内容
    if os.path.isdir(ORIGINAL_JS_DIR):
        print('\n[JS] 检查 original_js 模块是否存在于本地 js:')
        for orig_file in os.listdir(ORIGINAL_JS_DIR):
            if not orig_file.endswith('.js'):
                continue
            with open(os.path.join(ORIGINAL_JS_DIR, orig_file), 'r', encoding='utf-8', errors='ignore') as f:
                orig_content = f.read()
            # 取第一个 mod_pagespeed 变量的前 80 字符作为指纹
            m = re.search(r'var mod_pagespeed_\S+\s*=\s*"(.{40,120})', orig_content)
            if not m:
                continue
            fingerprint = m.group(1)[:80]
            if fingerprint in local_blob:
                print(f'  [OK] {orig_file}')
            else:
                is_critical = any(mod in orig_file for mod in CRITICAL_MODULES)
                tag = 'CRITICAL' if is_critical else 'WARN'
                print(f'  [{tag}] {orig_file} - 本地 js 中未找到对应模块')

    return len(missing_snippets) == 0


def check_ajax_patch():
    """检查 index.html 本地化补丁中的 Ajax 方法名是否与游戏一致"""
    html_path = os.path.join(BASE_DIR, 'index.html')
    ajax_path = os.path.join(LOCAL_JS_DIR, '3d5f98a4952a4fdd5e39b46544196ec3.js')
    if not os.path.exists(html_path) or not os.path.exists(ajax_path):
        print('[补丁] 跳过 Ajax 方法名检查（文件不存在）')
        return

    with open(ajax_path, 'r', encoding='utf-8') as f:
        ajax_methods = set(re.findall(r"_call\(successfn,errorfn,completefn,'([^']+)'", f.read()))
    with open(html_path, 'r', encoding='utf-8') as f:
        patch = f.read()

    patch_cases = set(re.findall(r"case '([^']+)':", patch))
    # 只关心补丁里显式处理的 RPC 方法
    rpc_cases = {c for c in patch_cases if '.' in c or c in ('getAIs', 'getPlayerDetails', 'getCurrency', 'getScraps', 'getStatistics', 'getFavourites', 'getPrimaryContent', 'getTutorialProgress', 'ping', 'updateTutorialProgress')}

    bad = []
    for case in rpc_cases:
        if case not in ajax_methods:
            bad.append(case)

    stale = []
    for wrong in ('tanktrouble.getAIs', 'tanktrouble.getPlayerDetails', 'tanktrouble.getGarageContent'):
        if wrong in patch:
            stale.append(wrong)

    print('[补丁] Ajax 方法名检查:')
    if stale:
        for s in stale:
            print(f'  [ERROR] 使用了错误前缀: {s}')
    else:
        print('  [OK] 无 tanktrouble.* 错误前缀')
    if bad:
        for b in bad:
            print(f'  [WARN] 补丁 case 不在 ajax.js 中: {b}')
    else:
        print('  [OK] 补丁 case 与 ajax.js 一致')


def main():
    parser = argparse.ArgumentParser(description='对比完整版并恢复 game_core 缺失内容')
    parser.add_argument('--check-js', action='store_true', help='检查 JS 完整性')
    parser.add_argument('--assets', action='store_true', help='下载缺失资源')
    parser.add_argument('--all', action='store_true', help='执行全部检查与恢复')
    args = parser.parse_args()

    if not (args.check_js or args.assets or args.all):
        args.all = True

    print('=' * 60)
    print('game_core 程序化恢复工具')
    print('=' * 60)

    if args.all or args.assets:
        restore_assets()
    if args.all or args.check_js:
        check_js_integrity()
        check_ajax_patch()

    print('\n完成。请运行 game_core/server.py 或 启动游戏.bat 测试。')


if __name__ == '__main__':
    main()
