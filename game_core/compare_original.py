# -*- coding: utf-8 -*-
"""
对比原始游戏和本地修改版本的差异
1. 下载原始游戏的完整页面
2. 提取所有JS文件URL
3. 下载关键JS文件
4. 与本地版本对比，找出被删除/修改的关键代码
"""
import os
import sys
import re
import json
import hashlib
import urllib.request
import urllib.error
from pathlib import Path

if sys.platform == 'win32':
    sys.stdout.reconfigure(encoding='utf-8')
    sys.stderr.reconfigure(encoding='utf-8')

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
CDN_BASE = "https://cdn.tanktrouble.com/RELEASE-2026-05-11-01"
ORIGINAL_DIR = os.path.join(BASE_DIR, "original_js")
LOCAL_JS_DIR = os.path.join(BASE_DIR, "js")
REPORT_FILE = os.path.join(BASE_DIR, "diff_report.txt")

# 关键词 - 我们重点关注AI、游戏流程、玩家面板相关的代码
KEYWORDS = [
    'AIs', 'AIManager', 'AI.', 'ai_laika', 'ai_dimitri',
    'createGuests', 'getAIs', 'getPlayerDetails',
    'PlayerDetails', 'playerPanel', 'UIPlayerPanel',
    'main()', 'function main', 'Content.init',
    'Game.UIMenuState', 'Game.UILobbyState', 'Game.UIGameState',
    'InputState', 'gameController', 'addAI',
    'TankInfoBox', 'GarageOverlay', 'sprayPaint',
    'SoundButton', 'MusicButton', 'volumeLow', 'volumeMedium', 'volumeHigh',
    'Inputs', 'getAllInputSetIds', 'WASDKeys', 'arrowKeys',
    'LoginOverlay', 'SignUpOverlay', 'messagesSnippet',
    'Scrapyard', 'Statistics',
]

def download_file(url, save_path):
    """下载文件"""
    try:
        req = urllib.request.Request(url, headers={
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Accept': '*/*',
            'Referer': 'https://tanktrouble.com/'
        })
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = resp.read()
            os.makedirs(os.path.dirname(save_path), exist_ok=True)
            with open(save_path, 'wb') as f:
                f.write(data)
            return data
    except Exception as e:
        print(f"  [FAIL] {url}: {e}")
        return None

def extract_js_urls_from_html(html_content):
    """从HTML中提取所有JS文件URL"""
    urls = []
    # 匹配 <script src="..."></script>
    for m in re.finditer(r'<script\s+src="([^"]+)"', html_content):
        url = m.group(1)
        if url.startswith('//'):
            url = 'https:' + url
        urls.append(url)
    return urls

def extract_combined_js_urls(html_content):
    """提取pagespeed组合JS URL（包含多个模块的合并文件）"""
    urls = []
    for m in re.finditer(r'<script\s+src="(https://cdn\.tanktrouble\.com/[^"]+\.js)"', html_content):
        urls.append(m.group(1))
    return urls

def extract_module_names_from_url(url):
    """从pagespeed组合URL中提取模块名"""
    # 例如: js/tt/ais.js+aimanager.js+ai.js.pagespeed.jc.LsmNGKab1x.js
    # 提取 ais.js, aimanager.js, ai.js
    match = re.search(r'/js/(.+)\.pagespeed\.', url)
    if not match:
        return []
    path = match.group(1)
    # 分割 + 号连接的模块
    modules = path.split('+')
    return modules

def find_local_js_file(module_name):
    """在本地js目录中查找对应的JS文件"""
    # module_name 如: tt/ais.js, tt/aimanager.js, backend.js
    # 本地文件名是hash化的，需要通过内容搜索
    target_name = module_name.replace('/', '_').replace('.js', '')
    
    # 先尝试直接匹配文件名
    for f in os.listdir(LOCAL_JS_DIR):
        if f.endswith('.js'):
            fpath = os.path.join(LOCAL_JS_DIR, f)
            try:
                with open(fpath, 'r', encoding='utf-8', errors='ignore') as fh:
                    content = fh.read()
                    # 检查是否包含模块标识
                    # 例如 ais.js 会包含 AIs 类定义
                    if module_name == 'tt/ais.js' and ('var AIs=' in content or 'AIs=' in content):
                        return fpath
                    elif module_name == 'tt/aimanager.js' and ('var AIManager=' in content or 'AIManager=' in content):
                        return fpath
                    elif module_name == 'tt/ai.js' and ('var AI=' in content or 'AI.constructor' in content):
                        return fpath
                    elif module_name == 'backend.js' and ('var Backend=' in content):
                        return fpath
                    elif module_name == 'main.js' and ('function main(' in content):
                        return fpath
                    elif module_name == 'content.js' and ('var Content=' in content):
                        return fpath
                    elif module_name == 'inputs.js' and ('var Inputs=' in content):
                        return fpath
                    elif module_name == 'users.js' and ('var Users=' in content):
                        return fpath
            except:
                pass
    return None

def search_keyword_in_file(filepath, keyword):
    """在文件中搜索关键词"""
    try:
        with open(filepath, 'r', encoding='utf-8', errors='ignore') as f:
            content = f.read()
        return keyword in content
    except:
        return False

def search_keyword_in_all_local_js(keyword):
    """在所有本地JS文件中搜索关键词"""
    found = []
    if not os.path.exists(LOCAL_JS_DIR):
        return found
    for f in os.listdir(LOCAL_JS_DIR):
        if f.endswith('.js'):
            fpath = os.path.join(LOCAL_JS_DIR, f)
            if search_keyword_in_file(fpath, keyword):
                found.append(fpath)
    return found

def download_and_analyze_original():
    """下载原始游戏并分析"""
    print("=" * 70)
    print("步骤1: 下载原始游戏HTML")
    print("=" * 70)
    
    # 读取本地备份的原始HTML
    backup_path = os.path.join(BASE_DIR, "original_backup.html")
    if os.path.exists(backup_path):
        with open(backup_path, 'r', encoding='utf-8') as f:
            html_content = f.read()
        print(f"  从本地备份读取: {backup_path}")
    else:
        print("  从CDN下载原始页面...")
        # 尝试下载主页
        data = download_file("https://tanktrouble.com/", os.path.join(ORIGINAL_DIR, "index.html"))
        if data:
            html_content = data.decode('utf-8', errors='ignore')
        else:
            print("  [ERROR] 无法下载原始页面")
            return
    
    print("=" * 70)
    print("步骤2: 提取JS文件URL")
    print("=" * 70)
    
    js_urls = extract_combined_js_urls(html_content)
    print(f"  找到 {len(js_urls)} 个组合JS文件URL")
    
    # 提取所有模块名
    all_modules = []
    for url in js_urls:
        modules = extract_module_names_from_url(url)
        all_modules.extend([(m, url) for m in modules])
    
    print(f"  共 {len(all_modules)} 个JS模块")
    
    # 重点关注AI相关的模块
    ai_modules = [(m, url) for m, url in all_modules if any(kw.lower() in m.lower() for kw in ['ai', 'ais', 'aimanager'])]
    print(f"\n  AI相关模块: {len(ai_modules)}")
    for m, url in ai_modules:
        print(f"    - {m} <- {url}")
    
    # 重点关注游戏流程模块
    game_modules = [(m, url) for m, url in all_modules if any(kw.lower() in m.lower() for kw in ['game', 'content', 'main', 'player', 'lobby', 'menu'])]
    print(f"\n  游戏流程模块: {len(game_modules)}")
    for m, url in game_modules:
        print(f"    - {m} <- {url}")
    
    print("\n" + "=" * 70)
    print("步骤3: 下载关键组合JS文件")
    print("=" * 70)
    
    # 下载AI相关的组合JS文件
    ai_urls = set()
    for m, url in ai_modules:
        ai_urls.add(url)
    
    # 也下载游戏核心相关的
    for m, url in game_modules:
        if any(kw in m for kw in ['gamecontroller', 'gamemodel', 'roundcontroller', 'roundmodel', 'content', 'main']):
            ai_urls.add(url)
    
    # 还要下载 backend.js, ajax.js, inputs.js, users.js 等
    for m, url in all_modules:
        if any(kw in m for kw in ['backend', 'ajax', 'inputs', 'users', 'caches', 'playerdetails', 'newgameoverlay', 'adduserbox', 'selectuserbox', 'tankinfobox', 'garageoverlay', 'soundbutton', 'musicbutton', 'settingsbutton']):
            ai_urls.add(url)
    
    downloaded_files = {}
    for url in ai_urls:
        filename = url.split('/')[-1]
        save_path = os.path.join(ORIGINAL_DIR, filename)
        print(f"  下载: {filename}")
        data = download_file(url, save_path)
        if data:
            downloaded_files[url] = save_path
            print(f"    OK ({len(data)} bytes)")
        else:
            print(f"    FAILED")
    
    print(f"\n  成功下载 {len(downloaded_files)} 个文件")
    
    print("\n" + "=" * 70)
    print("步骤4: 在原始JS中搜索关键代码")
    print("=" * 70)
    
    # 搜索所有下载的原始JS文件中的关键代码
    original_code_snippets = {}
    for url, fpath in downloaded_files.items():
        try:
            with open(fpath, 'r', encoding='utf-8', errors='ignore') as f:
                content = f.read()
        except:
            continue
        
        for kw in KEYWORDS:
            if kw in content:
                if kw not in original_code_snippets:
                    original_code_snippets[kw] = []
                # 提取关键词周围的代码
                idx = content.find(kw)
                start = max(0, idx - 200)
                end = min(len(content), idx + 500)
                snippet = content[start:end]
                original_code_snippets[kw].append({
                    'file': os.path.basename(fpath),
                    'url': url,
                    'snippet': snippet
                })
    
    print(f"  在原始JS中找到 {len(original_code_snippets)} 个关键词")
    for kw, entries in original_code_snippets.items():
        print(f"    '{kw}': {len(entries)} 处")
    
    print("\n" + "=" * 70)
    print("步骤5: 在本地JS中搜索相同关键词，找出缺失")
    print("=" * 70)
    
    missing_keywords = []
    for kw in KEYWORDS:
        local_found = search_keyword_in_all_local_js(kw)
        if not local_found:
            missing_keywords.append(kw)
            print(f"  [MISSING] '{kw}' 在本地JS中未找到!")
        else:
            print(f"  [OK] '{kw}' 在 {len(local_found)} 个本地文件中存在")
    
    print("\n" + "=" * 70)
    print("步骤6: 深度对比 - 检查原始JS中的关键函数定义")
    print("=" * 70)
    
    # 在原始JS中搜索关键函数的完整定义
    critical_functions = [
        'AIs.init', 'AIs.update', 'AIs.getAI',
        'Backend.getInstance', 'Backend.createGuests', 'Backend.getAIs',
        'Content.init', 'Content.navigateToTab',
        'main(', 'function main',
        'Game.UIMenuState', 'Game.UILobbyState',
        'AIManager.update', 'AI.update',
    ]
    
    for func_name in critical_functions:
        found_in_original = False
        found_in_local = False
        original_file = ""
        
        # 在原始文件中搜索
        for url, fpath in downloaded_files.items():
            try:
                with open(fpath, 'r', encoding='utf-8', errors='ignore') as f:
                    if func_name in f.read():
                        found_in_original = True
                        original_file = os.path.basename(fpath)
                        break
            except:
                pass
        
        # 在本地文件中搜索
        local_found = search_keyword_in_all_local_js(func_name)
        if local_found:
            found_in_local = True
        
        status = ""
        if found_in_original and not found_in_local:
            status = "[CRITICAL MISSING] 原始有但本地缺失!"
        elif found_in_original and found_in_local:
            status = "[OK] 两边都有"
        elif not found_in_original:
            status = "[N/A] 原始也没有（可能在未下载的文件中）"
        
        print(f"  {func_name}: {status}")
        if found_in_original:
            print(f"    原始文件: {original_file}")
        if local_found:
            print(f"    本地文件: {os.path.basename(local_found[0])}")
    
    print("\n" + "=" * 70)
    print("步骤7: 生成详细报告")
    print("=" * 70)
    
    with open(REPORT_FILE, 'w', encoding='utf-8') as f:
        f.write("TankTrouble 本地版 vs 原始版 差异报告\n")
        f.write("=" * 70 + "\n\n")
        
        f.write("## 缺失的关键词\n")
        for kw in missing_keywords:
            f.write(f"  - {kw}\n")
            if kw in original_code_snippets:
                for entry in original_code_snippets[kw]:
                    f.write(f"    原始文件: {entry['file']}\n")
                    f.write(f"    代码片段:\n")
                    f.write(f"    ...{entry['snippet']}...\n\n")
        
        f.write("\n## 原始JS中找到的关键代码片段\n")
        for kw, entries in original_code_snippets.items():
            f.write(f"\n### {kw}\n")
            for entry in entries:
                f.write(f"  文件: {entry['file']}\n")
                f.write(f"  URL: {entry['url']}\n")
                f.write(f"  代码:\n  ...{entry['snippet']}...\n\n")
    
    print(f"  报告已保存到: {REPORT_FILE}")
    
    # 额外：搜索本地index.html中的补丁代码
    print("\n" + "=" * 70)
    print("步骤8: 检查本地index.html中的补丁覆盖情况")
    print("=" * 70)
    
    index_path = os.path.join(BASE_DIR, "index.html")
    if os.path.exists(index_path):
        with open(index_path, 'r', encoding='utf-8') as f:
            index_content = f.read()
        
        # 检查补丁中的关键覆盖
        patches = [
            ('AIs.init', 'AI初始化补丁'),
            ('Backend.getInstance', 'Backend单例补丁'),
            ('Backend.createGuests', '创建访客补丁'),
            ('getPlayerDetails', '玩家详情补丁'),
            ('requestAnimationFrame', '游戏循环补丁'),
            ('AIs.update', 'AI更新补丁'),
            ('AudioManager', '音频管理补丁'),
            ('SoundButton', '音量按钮补丁'),
            ('Inputs.getAllInputSetIds', '输入设置补丁'),
        ]
        
        for patch_name, desc in patches:
            if patch_name in index_content:
                print(f"  [PATCHED] {desc} ({patch_name})")
            else:
                print(f"  [NOT PATCHED] {desc} ({patch_name})")
    
    return original_code_snippets, missing_keywords

if __name__ == '__main__':
    original_code_snippets, missing_keywords = download_and_analyze_original()
    print("\n\n分析完成!")
    if missing_keywords:
        print(f"\n发现 {len(missing_keywords)} 个缺失的关键词，请查看报告: {REPORT_FILE}")
    else:
        print("\n所有关键词在本地版本中都存在!")
