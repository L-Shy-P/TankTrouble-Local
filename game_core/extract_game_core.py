# -*- coding: utf-8 -*-
"""
提取游戏核心文件到game_core目录
"""
import os
import sys
import re
import shutil
import hashlib
from pathlib import Path

# 修复Windows控制台编码问题
if sys.platform == 'win32':
    sys.stdout.reconfigure(encoding='utf-8')
    sys.stderr.reconfigure(encoding='utf-8')

CACHE_DIR = "../cache"
GAME_CORE_DIR = "."

def get_cache_path(url):
    """根据URL生成本地缓存路径"""
    from urllib.parse import urlparse
    parsed = urlparse(f"https://{url}" if not url.startswith("http") else url)
    url_hash = hashlib.md5(url.encode('utf-8')).hexdigest()
    
    path = parsed.path
    ext = os.path.splitext(path)[1]
    if ext and len(ext) <= 10:
        filename = url_hash + ext
    else:
        filename = url_hash
    
    domain = parsed.netloc.replace('.', '_')
    cache_path = os.path.join(CACHE_DIR, domain, filename)
    
    return cache_path

def extract_all_files():
    """提取所有需要的文件"""
    print("=" * 80)
    print("开始提取游戏核心文件...")
    print("=" * 80)
    
    # 创建目录结构
    os.makedirs("RELEASE-2026-05-11-01/js", exist_ok=True)
    os.makedirs("RELEASE-2026-05-11-01/css", exist_ok=True)
    os.makedirs("RELEASE-2026-05-11-01/assets/images", exist_ok=True)
    os.makedirs("RELEASE-2026-05-11-01/assets/audio", exist_ok=True)
    os.makedirs("RELEASE-2026-05-11-01/assets/spine", exist_ok=True)
    os.makedirs("js/jquery", exist_ok=True)
    os.makedirs("css/jquery", exist_ok=True)
    
    # 从HTML中提取所有需要的文件URL
    HTML_FILE = os.path.join(CACHE_DIR, "tanktrouble_com", "d83e8760a65b41e47f1bbcb7329531d9")
    with open(HTML_FILE, 'r', encoding='utf-8', errors='replace') as f:
        html = f.read()
    
    # 提取所有script src
    script_urls = re.findall(r'<script[^>]+src="([^"]+)"', html)
    
    # 提取所有CSS link
    css_urls = re.findall(r'<link[^>]+href="([^"]+\.css[^"]*)"', html)
    
    # 提取所有图片资源（从CSS中）
    CSS_FILE = os.path.join(CACHE_DIR, "cdn_tanktrouble_com", "470197018390ae7bcec6a199667c77e5.css")
    if os.path.exists(CSS_FILE):
        with open(CSS_FILE, 'r', encoding='utf-8', errors='replace') as f:
            css_content = f.read()
        # 提取url()中的图片
        img_urls = re.findall(r'url\(["\']?([^"\'\)]+)["\']?\)', css_content)
    
    # 复制jQuery文件
    jquery_files = [
        ("code.jquery.com/jquery-1.11.2.min.js", "js/jquery/jquery-1.11.2.min.js"),
        ("code.jquery.com/ui/1.11.4/jquery-ui.min.js", "js/jquery/jquery-ui.min.js"),
    ]
    
    for src, dst in jquery_files:
        cache_path = get_cache_path(src)
        if os.path.exists(cache_path):
            shutil.copy2(cache_path, dst)
            print(f"✓ jQuery: {os.path.basename(dst)}")
        else:
            print(f"✗ jQuery未找到: {src}")
    
    # 复制jQuery CSS
    jquery_css = [
        ("code.jquery.com/jquery-ui.css", "css/jquery/jquery-ui.css"),
    ]
    
    for src, dst in jquery_css:
        cache_path = get_cache_path(src)
        if os.path.exists(cache_path):
            shutil.copy2(cache_path, dst)
            print(f"✓ jQuery CSS: {os.path.basename(dst)}")
    
    # 复制所有CDN JS文件
    cdn_js_count = 0
    for url in script_urls:
        if "cdn.tanktrouble.com" in url:
            # 提取相对路径
            rel_path = url.replace("https://cdn.tanktrouble.com/", "")
            cache_path = get_cache_path(url)
            if os.path.exists(cache_path):
                target_path = os.path.join("RELEASE-2026-05-11-01", os.path.dirname(rel_path), os.path.basename(rel_path))
                os.makedirs(os.path.dirname(target_path), exist_ok=True)
                shutil.copy2(cache_path, target_path)
                cdn_js_count += 1
    
    print(f"✓ CDN JS文件: {cdn_js_count}个")
    
    # 复制CSS文件
    css_count = 0
    for url in css_urls:
        if "cdn.tanktrouble.com" in url:
            rel_path = url.replace("https://cdn.tanktrouble.com/", "")
            cache_path = get_cache_path(url)
            if os.path.exists(cache_path):
                target_path = os.path.join("RELEASE-2026-05-11-01", os.path.dirname(rel_path), os.path.basename(rel_path))
                os.makedirs(os.path.dirname(target_path), exist_ok=True)
                shutil.copy2(cache_path, target_path)
                css_count += 1
    
    print(f"✓ CSS文件: {css_count}个")
    
    # 复制图片资源
    img_count = 0
    img_extensions = ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.webp']
    
    # 扫描缓存目录中的所有图片
    for root, dirs, files in os.walk(CACHE_DIR):
        for file in files:
            if any(file.lower().endswith(ext) for ext in img_extensions):
                src_path = os.path.join(root, file)
                # 根据文件类型决定目标路径
                if "cdn_tanktrouble_com" in root:
                    # 检查是否是游戏资源
                    rel_path = os.path.relpath(src_path, os.path.join(CACHE_DIR, "cdn_tanktrouble_com"))
                    if "assets" in rel_path or "images" in rel_path:
                        target_path = os.path.join("RELEASE-2026-05-11-01", rel_path)
                        os.makedirs(os.path.dirname(target_path), exist_ok=True)
                        shutil.copy2(src_path, target_path)
                        img_count += 1
    
    print(f"✓ 图片资源: {img_count}个")
    
    # 复制favicon
    favicon_cache = os.path.join(CACHE_DIR, "cdn_tanktrouble_com", "8df14eb4e8559a35141bca6e52f78bc5.ico")
    if os.path.exists(favicon_cache):
        shutil.copy2(favicon_cache, "RELEASE-2026-05-11-01/favicon.ico")
        print("✓ Favicon")
    
    print("=" * 80)
    print("文件提取完成！")
    print("=" * 80)

if __name__ == "__main__":
    extract_all_files()
