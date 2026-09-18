# -*- coding: utf-8 -*-
"""
提取游戏核心文件 - 完整保留版
保留所有原始JS文件和mod_pagespeed变量
"""
import os
import sys
import re
import shutil
import hashlib

if sys.platform == 'win32':
    sys.stdout.reconfigure(encoding='utf-8')
    sys.stderr.reconfigure(encoding='utf-8')

CACHE_DIR = os.path.join("..", "cache")
OUT_DIR = "."
ORIGINAL_HTML = os.path.join(CACHE_DIR, "tanktrouble_com", "d83e8760a65b41e47f1bbcb7329531d9")


def url_to_output_path(url):
    """URL -> 输出文件路径"""
    if url.startswith('//code.jquery.com/') or url.startswith('https://code.jquery.com/'):
        path = url.split('code.jquery.com/')[-1]
        if 'jquery-1.11.2.min.js' in path:
            return 'js/jquery/jquery-1.11.2.min.js'
        elif 'jquery-ui.min.js' in path:
            return 'js/jquery/jquery-ui.min.js'
        elif 'jquery-ui.css' in path:
            return 'css/jquery/jquery-ui.css'
        return None
    elif 'cdn.tanktrouble.com' in url:
        path = url.split('cdn.tanktrouble.com/')[-1]
        path = re.sub(r'^RELEASE-\d{4}-\d{2}-\d{2}-\d{2}/', '', path)
        md5 = hashlib.md5(path.encode()).hexdigest()
        if path.endswith('.js'):
            return f'js/{md5}.js'
        elif path.endswith('.css'):
            return f'css/{md5}.css'
        elif path.endswith('.ico'):
            return f'assets/{md5}.ico'
        elif path.endswith('.png'):
            return f'assets/{md5}.png'
        elif path.endswith('.svg'):
            return f'assets/{md5}.svg'
    return None


def url_to_cache_path(url):
    """URL -> 缓存文件路径"""
    md5 = hashlib.md5(url.encode('utf-8')).hexdigest()
    if 'code.jquery.com' in url:
        domain = 'code_jquery_com'
    elif 'cdn.tanktrouble.com' in url:
        domain = 'cdn_tanktrouble_com'
    else:
        return None
    path = url.split(url.split('/')[2] + '/')[-1]
    ext = os.path.splitext(path)[1]
    if ext and len(ext) <= 10:
        filename = md5 + ext
    else:
        filename = md5
    return os.path.join(CACHE_DIR, domain, filename)


def fix_mod_pagespeed_in_file(filepath):
    """修复JS文件中的mod_pagespeed变量，添加eval语句"""
    with open(filepath, 'r', encoding='utf-8', errors='replace') as f:
        content = f.read()

    # 查找所有mod_pagespeed变量定义
    pattern = r'var\s+(mod_pagespeed_\w+)\s*=\s*"((?:[^"\\]|\\.)*)";\s*\n'
    matches = list(re.finditer(pattern, content, re.DOTALL))

    if not matches:
        return 0

    # 从后往前添加eval语句
    for match in reversed(matches):
        var_name = match.group(1)
        eval_stmt = f'\neval({var_name});'
        insert_pos = match.end()
        content = content[:insert_pos] + eval_stmt + content[insert_pos:]

    with open(filepath, 'w', encoding='utf-8') as f:
        f.write(content)

    return len(matches)


def extract():
    print("=" * 60)
    print("提取游戏核心文件 - 基于原始HTML修改")
    print("=" * 60)

    # 创建输出目录
    for d in ["js/jquery", "css/jquery", "assets"]:
        os.makedirs(os.path.join(OUT_DIR, d), exist_ok=True)

    # 读取原始HTML
    with open(ORIGINAL_HTML, 'r', encoding='utf-8') as f:
        html = f.read()

    # 备份原始HTML
    backup_path = os.path.join(OUT_DIR, "original_backup.html")
    with open(backup_path, 'w', encoding='utf-8') as f:
        f.write(html)
    print(f"[备份] 原始HTML已备份到: {backup_path}")

    # 备份原始HTML
    backup_path = os.path.join(OUT_DIR, "original_backup.html")
    with open(backup_path, 'w', encoding='utf-8') as f:
        f.write(html)
    print(f"[备份] 原始HTML已备份到: {backup_path}")

    # 0. 复制jQuery文件（从code.jquery.com下载）
    print("\n[0/5] 下载jQuery文件...")
    import urllib.request
    
    jquery_files = [
        ("https://code.jquery.com/jquery-1.11.2.min.js", "js/jquery/jquery-1.11.2.min.js"),
        ("https://code.jquery.com/ui/1.11.4/jquery-ui.min.js", "js/jquery/jquery-ui.min.js"),
        ("https://code.jquery.com/ui/1.11.4/themes/smoothness/jquery-ui.css", "css/jquery/jquery-ui.css"),
    ]
    
    for url, local_path in jquery_files:
        target = os.path.join(OUT_DIR, local_path)
        if not os.path.exists(target):
            try:
                print(f"  下载: {url}")
                urllib.request.urlretrieve(url, target)
                print(f"  [OK] {local_path}")
            except Exception as e:
                print(f"  [X] 下载失败 {local_path}: {e}")
        else:
            print(f"  [已存在] {local_path}")

    # 1. 复制所有CDN JS文件并修复mod_pagespeed
    print("\n[1/5] 复制并修复CDN JS文件...")
    js_files = []
    for m in re.finditer(r'<script[^>]+src="([^"]+)"', html):
        url = m.group(1)
        # 只跳过明确的外部脚本（广告、分析、支付等）
        if any(x in url for x in ['google-analytics.com', 'js.stripe.com',
                                    'imasdk.googleapis.com', 'googlesyndication',
                                    'pagead2.googlesyndication']):
            continue
        # 跳过jQuery（硬编码路径，前面已处理）
        if 'code.jquery.com' in url:
            continue
        # 处理CDN JS
        if 'cdn.tanktrouble.com' in url:
            out_path = url_to_output_path(url)
            cache_path = url_to_cache_path(url)
            if out_path and cache_path and os.path.exists(cache_path):
                target = os.path.join(OUT_DIR, out_path)
                if not os.path.exists(target):
                    shutil.copy2(cache_path, target)
                js_files.append(out_path)

    total_vars = sum(c for _, c in js_files)
    print(f"  [OK] 共 {len(js_files)} 个JS文件, {total_vars} 个mod_pagespeed变量")

    # 2. 复制CSS文件
    print("\n[2/5] 复制CSS文件...")
    css_files = []
    for m in re.finditer(r'<link[^>]+href="([^"]+)"', html):
        url = m.group(1)
        if 'cdn.tanktrouble.com' in url:
            out_path = url_to_output_path(url)
            cache_path = url_to_cache_path(url)
            if out_path and cache_path and os.path.exists(cache_path):
                # 只处理CSS文件，跳过图标
                if out_path.endswith('.css'):
                    target = os.path.join(OUT_DIR, out_path)
                    if not os.path.exists(target):
                        shutil.copy2(cache_path, target)
                    css_files.append(out_path)
                    print(f"  [OK] {out_path}")

    # 3. 复制图片/图标
    print("\n[3/5] 复制图片资源...")
    cdn_cache = os.path.join(CACHE_DIR, "cdn_tanktrouble_com")
    img_count = 0
    if os.path.exists(cdn_cache):
        for f in os.listdir(cdn_cache):
            if f.endswith(('.png', '.ico', '.svg', '.jpg', '.gif', '.webp')):
                src = os.path.join(cdn_cache, f)
                dst = os.path.join(OUT_DIR, "assets", f)
                if not os.path.exists(dst):
                    shutil.copy2(src, dst)
                    img_count += 1

    # jQuery CSS图片
    jquery_cache = os.path.join(CACHE_DIR, "code_jquery_com")
    if os.path.exists(jquery_cache):
        for f in os.listdir(jquery_cache):
            if f.endswith(('.png', '.gif', '.jpg')):
                src = os.path.join(jquery_cache, f)
                dst = os.path.join(OUT_DIR, "css", f)
                if not os.path.exists(dst):
                    shutil.copy2(src, dst)
                    img_count += 1
    print(f"  [OK] {img_count} 个图片资源")

    # 4. 基于原始HTML生成index.html
    print("\n[4/5] 生成index.html...")

    # 从原始HTML开始修改
    final_html = html

    # 4.1 替换CDN URL为本地路径
    def replace_cdn_url(match):
        full_match = match.group(0)
        url = match.group(1)

        # 跳过外部脚本
        if any(x in url for x in ['google-analytics.com', 'js.stripe.com',
                                    'imasdk.googleapis.com', 'googlesyndication',
                                    'pagead2.googlesyndication']):
            return ''  # 移除这些script标签

        # 处理jQuery
        if 'code.jquery.com' in url:
            if 'jquery-1.11.2.min.js' in url:
                return full_match.replace(url, 'js/jquery/jquery-1.11.2.min.js')
            elif 'jquery-ui.min.js' in url:
                return full_match.replace(url, 'js/jquery/jquery-ui.min.js')
            elif 'jquery-ui.css' in url:
                return full_match.replace(url, 'css/jquery/jquery-ui.css')
            return full_match

        # 处理CDN资源
        if 'cdn.tanktrouble.com' in url:
            out_path = url_to_output_path(url)
            if out_path:
                return full_match.replace(url, out_path)

        return full_match

    # 替换script src
    final_html = re.sub(r'<script\s+[^>]*src="([^"]+)"[^>]*>.*?</script>', replace_cdn_url, final_html, flags=re.DOTALL)
    # 替换link href
    final_html = re.sub(r'<link[^>]+href="([^"]+)"[^>]*/?>', replace_cdn_url, final_html)

    # 4.2 修改body部分：跳过content.php加载，直接调用main()
    final_html = re.sub(
        r'<script>\$\(function\(\)\{\$\("body"\)\.load\("RELEASE-[^"]+",\{tab:"game",requestURI:"/game"\},function\(\)\{main\(\);load_red_infiltration\(\);\}\);\}\);</script>',
        '<script>$(function(){main();load_red_infiltration();});</script>',
        final_html
    )

    # 4.3 注入本地化补丁到head开头
    local_patch = '''<script>
// 基础变量注入
var g_initialAdminRoles = {};
var g_url = function(path) { return path; };
var WebFont = { load: function(config) { if (config && config.active) setTimeout(config.active, 100); } };
var adBreak = adConfig = function(o) {};
var adsbygoogle = window.adsbygoogle || [];

// 本地化补丁
(function() {
    'use strict';

    var localIdCounter = 0;
    function generateLocalId() {
        localIdCounter++;
        return 'local_' + Date.now() + '_' + localIdCounter;
    }

    var localAIs = [
        {playerId: 'ai_easy', config: {difficulty: 0, name: 'Easy AI'}},
        {playerId: 'ai_medium', config: {difficulty: 1, name: 'Medium AI'}},
        {playerId: 'ai_hard', config: {difficulty: 2, name: 'Hard AI'}}
    ];

    var localPlayers = {};

    function createLocalPlayer(playerId) {
        if (!localPlayers[playerId]) {
            localPlayers[playerId] = {
                playerId: playerId,
                username: 'Player_' + playerId.substring(6, 14),
                victories: 0, kills: 0, deaths: 0, suicides: 0, surrenders: 0,
                experience: 0,
                turretColour: {type: 'solid', rawValue: '0x427fff', numericValue: '4358143', imageValue: ''},
                treadColour: {type: 'solid', rawValue: '0x427fff', numericValue: '4358143', imageValue: ''},
                baseColour: {type: 'solid', rawValue: '0x427fff', numericValue: '4358143', imageValue: ''},
                turretAccessory: '', barrelAccessory: '', frontAccessory: '',
                backAccessory: '', treadAccessory: '', backgroundAccessory: '',
                badge: '', premium: false, beta: false, verified: false,
                newsSubscriber: false, guest: true, lastForumPost: 0, gmLevel: 0
            };
        }
        return localPlayers[playerId];
    }

    // 拦截Ajax请求
    var originalXHROpen = XMLHttpRequest.prototype.open;
    var originalXHRSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function(method, url) {
        this._localUrl = url;
        if (url.indexOf('/ajax/') !== -1 || url.indexOf('content.php') !== -1) {
            this._isLocalRequest = true;
        }
        return originalXHROpen.apply(this, arguments);
    };

    XMLHttpRequest.prototype.send = function(data) {
        if (this._isLocalRequest) {
            var self = this;
            setTimeout(function() {
                self.readyState = 4;
                self.status = 200;
                self.responseText = JSON.stringify({success: true, data: {}});
                if (self.onreadystatechange) self.onreadystatechange();
                if (self.onload) self.onload();
            }, 50);
            return;
        }
        return originalXHRSend.apply(this, arguments);
    };

    function patchBackend() {
        if (typeof Backend === 'undefined') { setTimeout(patchBackend, 50); return; }

        var originalGetInstance = Backend.getInstance;
        var originalInstance = null;

        Backend.getInstance = function() {
            var instance = originalGetInstance.call(this);
            if (!originalInstance) {
                originalInstance = instance;

                instance.createGuests = function(successCallback, errorCallback, timeoutCallback, numberOfPlayers, cache) {
                    var playerIds = [], tokens = [];
                    for (var i = 0; i < numberOfPlayers; i++) {
                        var playerId = generateLocalId();
                        playerIds.push(playerId);
                        tokens.push('local_token_' + playerId);
                        createLocalPlayer(playerId);
                    }
                    setTimeout(function() { successCallback({playerIds: playerIds, multiplayerTokens: tokens}); }, 100);
                    return true;
                };

                instance.authenticate = function(playerId, token, successCallback, errorCallback, timeoutCallback) {
                    createLocalPlayer(playerId);
                    setTimeout(function() {
                        successCallback({playerId: playerId, username: localPlayers[playerId].username, guest: true});
                    }, 50);
                    return true;
                };

                instance.getAIs = function(successCallback, errorCallback, timeoutCallback) {
                    setTimeout(function() { successCallback(localAIs); }, 50);
                    return true;
                };

                instance.getGarageContent = function(successCallback, errorCallback, timeoutCallback, playerId, cache) {
                    setTimeout(function() { successCallback({playerId: playerId, boxes: []}); }, 50);
                    return true;
                };

                instance.getPlayerDetails = function(successCallback, errorCallback, timeoutCallback, playerIds, cache) {
                    setTimeout(function() {
                        var details = [];
                        for (var i = 0; i < playerIds.length; i++) details.push(createLocalPlayer(playerIds[i]));
                        successCallback(details);
                    }, 50);
                    return true;
                };

                instance.getContent = function(successCallback, errorCallback, timeoutCallback) {
                    setTimeout(function() { successCallback({}); }, 50);
                    return true;
                };

                instance.getNews = function(successCallback, errorCallback, timeoutCallback) {
                    setTimeout(function() { successCallback([]); }, 50);
                    return true;
                };

                instance.getMessages = function(successCallback, errorCallback, timeoutCallback) {
                    setTimeout(function() { successCallback([]); }, 50);
                    return true;
                };
            }
            return instance;
        };
    }

    function patchUsers() {
        if (typeof Users === 'undefined') { setTimeout(patchUsers, 50); return; }
        Users.loadAuthenticatedUsers = function() {};
        Users.loadGuestUsers = function() {};
        var origAddGuestUser = Users.addGuestUser;
        Users.addGuestUser = function(playerId, token) {
            createLocalPlayer(playerId);
            if (origAddGuestUser) return origAddGuestUser.call(this, playerId, token);
        };
        var origAddGuestUsers = Users.addGuestUsers;
        Users.addGuestUsers = function(playerIds, tokens) {
            for (var i = 0; i < playerIds.length; i++) createLocalPlayer(playerIds[i]);
            if (origAddGuestUsers) return origAddGuestUsers.call(this, playerIds, tokens);
        };
    }

    patchBackend();
    patchUsers();
})();
</script>
'''

    # 在<head>标签后插入本地化补丁
    final_html = final_html.replace('<head>', '<head>\n' + local_patch, 1)

    output_path = os.path.join(OUT_DIR, "index.html")
    with open(output_path, 'w', encoding='utf-8') as f:
        f.write(final_html)
    print(f"  [OK] index.html ({len(final_html)} bytes)")

    print("\n" + "=" * 60)
    print(f"完成！JS文件: {len(js_files)} 个, mod_pagespeed变量: {total_vars} 个")
    print("=" * 60)


if __name__ == "__main__":
    extract()
