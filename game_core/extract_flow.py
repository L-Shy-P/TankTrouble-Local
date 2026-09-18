# -*- coding: utf-8 -*-
"""提取UILobbyState中createLocalGame方法"""
import os, sys, re

if sys.platform == 'win32':
    sys.stdout.reconfigure(encoding='utf-8')

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
JS_DIR = os.path.join(BASE_DIR, "js")

# 加载所有mod_pagespeed变量
all_mod_vars = {}
for f in os.listdir(JS_DIR):
    if f.endswith('.js'):
        fpath = os.path.join(JS_DIR, f)
        with open(fpath, 'r', encoding='utf-8', errors='ignore') as fh:
            content = fh.read()
        pattern = r'var (mod_pagespeed_\S+)\s*=\s*"((?:[^"\\]|\\.)*)"'
        for m in re.finditer(pattern, content):
            var_name = m.group(1)
            var_value = m.group(2).replace('\\"', '"').replace('\\n', '\n')
            all_mod_vars[var_name] = var_value

# 搜索createLocalGame
print("=== 搜索 createLocalGame ===")
for var_name, var_code in all_mod_vars.items():
    if 'createLocalGame' in var_code:
        idx = var_code.find('createLocalGame')
        while idx >= 0:
            # 找到方法体
            brace_start = var_code.find('{', idx)
            if brace_start == -1:
                break
            brace_count = 1
            pos = brace_start + 1
            while pos < len(var_code) and brace_count > 0:
                if var_code[pos] == '{':
                    brace_count += 1
                elif var_code[pos] == '}':
                    brace_count -= 1
                pos += 1
            method = var_code[idx:pos]
            print(f"\n在 {var_name} 中找到 createLocalGame:")
            print(method[:2000])
            if len(method) > 2000:
                print(f"... (共 {len(method)} chars)")
            idx = var_code.find('createLocalGame', pos)

# 搜索AIs.addAIManager调用上下文
print("\n\n=== 搜索 AIs.addAIManager 调用上下文 ===")
for var_name, var_code in all_mod_vars.items():
    if 'AIs.addAIManager' in var_code:
        idx = var_code.find('AIs.addAIManager')
        while idx >= 0:
            # 找到包含此调用的方法
            # 向前搜索方法名
            search_start = max(0, idx - 500)
            context_before = var_code[search_start:idx]
            # 找最近的方法定义
            method_match = re.search(r'(\w+):function\(', context_before)
            method_name = method_match.group(1) if method_match else "unknown"

            # 找到完整方法体
            method_start = var_code.rfind(':function(', search_start, idx)
            if method_start >= 0:
                # 再往前找方法名
                name_start = var_code.rfind(',', 0, method_start)
                if name_start == -1:
                    name_start = 0
                else:
                    name_start += 1
                brace_start = var_code.find('{', method_start)
                brace_count = 1
                pos = brace_start + 1
                while pos < len(var_code) and brace_count > 0:
                    if var_code[pos] == '{':
                        brace_count += 1
                    elif var_code[pos] == '}':
                        brace_count -= 1
                    pos += 1
                full_method = var_code[name_start:pos]
                print(f"\n在 {var_name} 中, 方法 {method_name}:")
                print(full_method[:2000])
            else:
                print(f"\n在 {var_name} 中 (无法提取完整方法):")
                print(var_code[max(0,idx-200):idx+500])

            idx = var_code.find('AIs.addAIManager', idx + 1)

# 搜索Users.addGuestUsers
print("\n\n=== 搜索 Users.addGuestUsers ===")
for var_name, var_code in all_mod_vars.items():
    if 'addGuestUsers' in var_code:
        idx = var_code.find('addGuestUsers')
        while idx >= 0:
            brace_start = var_code.find('{', idx)
            if brace_start == -1 or brace_start - idx > 50:
                idx = var_code.find('addGuestUsers', idx + 1)
                continue
            brace_count = 1
            pos = brace_start + 1
            while pos < len(var_code) and brace_count > 0:
                if var_code[pos] == '{':
                    brace_count += 1
                elif var_code[pos] == '}':
                    brace_count -= 1
                pos += 1
            method = var_code[idx:pos]
            print(f"\n在 {var_name} 中找到 addGuestUsers:")
            print(method[:1500])
            idx = var_code.find('addGuestUsers', pos)
