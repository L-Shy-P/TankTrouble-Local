# -*- coding: utf-8 -*-
"""
分析缓存的JS文件，建立mod_pagespeed变量名到文件内容的映射
"""
import os
import re
import glob

CACHE_CDN = os.path.join("..", "cache", "cdn_tanktrouble_com")

# 扫描所有JS文件，提取mod_pagespeed变量名
var_to_file = {}
for js_file in glob.glob(os.path.join(CACHE_CDN, "*.js")):
    with open(js_file, 'r', encoding='utf-8', errors='replace') as f:
        content = f.read()
    # 匹配 var mod_pagespeed_XXX = "..."
    m = re.match(r'var\s+(mod_pagespeed_\w+)\s*=', content)
    if m:
        var_name = m.group(1)
        basename = os.path.basename(js_file)
        # 提取内容摘要（前200字符）
        str_match = re.search(r'=\s*"(.{0,200})', content)
        summary = str_match.group(1)[:200] if str_match else "N/A"
        var_to_file[var_name] = {
            'file': basename,
            'summary': summary
        }

# 读取HTML，提取所有eval(mod_pagespeed_XXX)和对应的src
HTML_FILE = os.path.join("..", "cache", "tanktrouble_com", "d83e8760a65b41e47f1bbcb7329531d9")
with open(HTML_FILE, 'r', encoding='utf-8', errors='replace') as f:
    html = f.read()

# 提取script标签
scripts = re.findall(r'<script[^>]*(?:src="([^"]*)")?[^>]*>(.*?)</script>', html, re.DOTALL)

print("=" * 80)
print("HTML SCRIPT ANALYSIS")
print("=" * 80)

current_src = None
for i, (src, body) in enumerate(scripts):
    if src:
        current_src = src
        # 检查是否是外部依赖
        is_external = any(x in src for x in ['googleapis', 'googlesyndication', 'google-analytics', 'stripe', 'imasdk'])
        tag = "[EXTERNAL]" if is_external else "[SRC]"
        print(f"\n{tag} Script #{i}: src={src}")
    
    # 查找eval语句
    evals = re.findall(r'eval\((mod_pagespeed_\w+)\)', body)
    for var_name in evals:
        if var_name in var_to_file:
            info = var_to_file[var_name]
            summary = info['summary'][:120]
            print(f"  eval({var_name}) -> {info['file']}")
            print(f"    Content: {summary}...")
        else:
            print(f"  eval({var_name}) -> [NOT FOUND IN CACHE]")

print("\n" + "=" * 80)
print("VARIABLE TO FILE MAPPING (ALL)")
print("=" * 80)
for var_name, info in sorted(var_to_file.items()):
    print(f"{var_name} -> {info['file']}")
    print(f"  {info['summary'][:150]}...")
