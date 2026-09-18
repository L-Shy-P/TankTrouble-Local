# -*- coding: utf-8 -*-
"""
复制缺失的JS文件到game_core目录
"""
import os
import re
import hashlib
import shutil

# 缓存目录
CACHE_DIR = '../cache'
# 输出目录
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

def copy_missing_files():
    """复制缺失的文件"""
    # 读取index.html
    index_path = os.path.join(OUTPUT_DIR, 'index.html')
    with open(index_path, 'r', encoding='utf-8') as f:
        html = f.read()

    # 提取所有JS文件引用
    js_refs = re.findall(r'<script\s+src="([^"]+\.js)"', html)
    # 提取所有CSS文件引用
    css_refs = re.findall(r'<link[^>]+href="([^"]+\.css)"', html)
    # 提取所有图片引用
    img_refs = re.findall(r'(?:src|href)="([^"]+\.(?:png|ico))"', html)

    # 统计
    js_copied = 0
    js_missing = 0
    css_copied = 0
    css_missing = 0
    img_copied = 0
    img_missing = 0

    # 复制JS文件
    for ref in js_refs:
        if ref.startswith('js/'):
            # 本地路径
            local_path = ref
            filename = os.path.basename(ref)
            target_path = os.path.join(OUTPUT_DIR, ref)

            # 检查文件是否存在
            if os.path.exists(target_path):
                continue

            # 从缓存中查找
            # 尝试所有可能的CDN URL
            found = False
            for host in ['//cdn.tanktrouble.com/RELEASE-2026-05-11-01/js/', 'https://cdn.tanktrouble.com/RELEASE-2026-05-11-01/js/']:
                # 这里我们无法直接知道原始URL，所以直接通过文件名查找
                pass

            # 直接在缓存中查找这个md5
            for host_dir in ['cdn_tanktrouble_com', 'code_jquery_com']:
                cache_file = os.path.join(CACHE_DIR, host_dir, filename)
                if os.path.exists(cache_file):
                    # 复制文件
                    os.makedirs(os.path.dirname(target_path), exist_ok=True)
                    shutil.copy2(cache_file, target_path)
                    print(f"[OK] 复制: {filename}")
                    js_copied += 1
                    found = True
                    break

            if not found:
                print(f"[X] 缺失: {ref}")
                js_missing += 1

    # 复制CSS文件
    for ref in css_refs:
        if ref.startswith('css/'):
            local_path = ref
            filename = os.path.basename(ref)
            target_path = os.path.join(OUTPUT_DIR, ref)

            if os.path.exists(target_path):
                continue

            # 在缓存中查找
            found = False
            for host_dir in ['cdn_tanktrouble_com', 'code_jquery_com']:
                cache_file = os.path.join(CACHE_DIR, host_dir, filename)
                if os.path.exists(cache_file):
                    os.makedirs(os.path.dirname(target_path), exist_ok=True)
                    shutil.copy2(cache_file, target_path)
                    print(f"[OK] 复制CSS: {filename}")
                    css_copied += 1
                    found = True
                    break

            if not found:
                print(f"[X] 缺失CSS: {ref}")
                css_missing += 1

    # 复制图片文件
    for ref in img_refs:
        if ref.startswith('assets/') or ref.startswith('css/'):
            filename = os.path.basename(ref)
            target_path = os.path.join(OUTPUT_DIR, ref)

            if os.path.exists(target_path):
                continue

            # 在缓存中查找
            found = False
            for host_dir in ['cdn_tanktrouble_com', 'code_jquery_com']:
                cache_file = os.path.join(CACHE_DIR, host_dir, filename)
                if os.path.exists(cache_file):
                    os.makedirs(os.path.dirname(target_path), exist_ok=True)
                    shutil.copy2(cache_file, target_path)
                    print(f"[OK] 复制图片: {filename}")
                    img_copied += 1
                    found = True
                    break

            if not found:
                print(f"[X] 缺失图片: {ref}")
                img_missing += 1

    print(f"\n=== 完成 ===")
    print(f"JS: 复制 {js_copied}, 缺失 {js_missing}")
    print(f"CSS: 复制 {css_copied}, 缺失 {css_missing}")
    print(f"图片: 复制 {img_copied}, 缺失 {img_missing}")

if __name__ == '__main__':
    copy_missing_files()
