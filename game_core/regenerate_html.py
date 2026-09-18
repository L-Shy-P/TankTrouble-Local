# -*- coding: utf-8 -*-
"""
重新生成游戏核心HTML
保留原始HTML的完整结构，包括所有eval调用
"""
import os
import re
import hashlib

# 缓存目录
CACHE_DIR = '../cache'
OUTPUT_DIR = '.'

def get_cache_path(url):
    """获取URL对应的缓存文件路径"""
    if url.startswith('//code.jquery.com/'):
        host_dir = 'code_jquery_com'
        path = url.replace('//code.jquery.com/', '')
    elif url.startswith('//cdn.tanktrouble.com/') or url.startswith('https://cdn.tanktrouble.com/'):
        host_dir = 'cdn_tanktrouble_com'
        path = url.replace('//cdn.tanktrouble.com/', '').replace('https://cdn.tanktrouble.com/', '')
        # 去掉RELEASE-xxx前缀
        path = re.sub(r'^RELEASE-\d{4}-\d{2}-\d{2}-\d{2}/', '', path)
    else:
        return None, None

    # 计算MD5
    md5 = hashlib.md5(path.encode()).hexdigest()

    # 确定扩展名
    if path.endswith('.js'):
        ext = '.js'
    elif path.endswith('.css'):
        ext = '.css'
    elif path.endswith('.ico'):
        ext = '.ico'
    elif path.endswith('.png'):
        ext = '.png'
    else:
        ext = ''

    cache_path = os.path.join(CACHE_DIR, host_dir, md5 + ext)
    if os.path.exists(cache_path):
        return cache_path, md5 + ext
    return None, None

def get_local_path(url):
    """获取URL对应的本地路径"""
    if url.startswith('//code.jquery.com/'):
        path = url.replace('//code.jquery.com/', '')
        if 'jquery-1.11.2.min.js' in path:
            return 'js/jquery/jquery-1.11.2.min.js'
        elif 'jquery-ui.min.js' in path:
            return 'js/jquery/jquery-ui.min.js'
        elif 'jquery-ui.css' in path:
            return 'css/jquery/jquery-ui.css'
        return None
    elif url.startswith('//cdn.tanktrouble.com/') or url.startswith('https://cdn.tanktrouble.com/'):
        path = url.replace('//cdn.tanktrouble.com/', '').replace('https://cdn.tanktrouble.com/', '')
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
    return None

def process_html():
    """处理原始HTML"""
    # 读取原始HTML
    original_html_path = os.path.join(CACHE_DIR, 'tanktrouble_com', 'd83e8760a65b41e47f1bbcb7329531d9')
    with open(original_html_path, 'r', encoding='utf-8') as f:
        html = f.read()

    # 替换所有CDN URL为本地路径
    def replace_url(match):
        url = match.group(1)
        local_path = get_local_path(url)
        if local_path:
            return match.group(0).replace(url, local_path)
        return match.group(0)

    # 替换script src
    html = re.sub(r'<script\s+src="([^"]+)"', replace_url, html)
    # 替换link href
    html = re.sub(r'<link[^>]+href="([^"]+)"', replace_url, html)

    # 添加本地化补丁到head开头
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
    html = html.replace('<head>', '<head>\n' + local_patch, 1)

    # 修改body部分：跳过content.php加载，直接调用main()
    # 原始: <script>$(function(){$("body").load("RELEASE-2026-05-11-01/content.php",{tab:"game",requestURI:"/game"},function(){main();load_red_infiltration();});});</script>
    # 修改为: <script>$(function(){main();load_red_infiltration();});</script>
    html = re.sub(
        r'<script>\$\(function\(\)\{\$\("body"\)\.load\([^)]+\)\);\}\);</script>',
        '<script>$(function(){main();load_red_infiltration();});</script>',
        html
    )

    # 保存
    output_path = os.path.join(OUTPUT_DIR, 'index.html')
    with open(output_path, 'w', encoding='utf-8') as f:
        f.write(html)

    print(f"已生成: {output_path}")

if __name__ == '__main__':
    process_html()
