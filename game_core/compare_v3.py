# -*- coding: utf-8 -*-
"""
精准对比脚本v3：下载原始游戏完整HTML，与本地版本逐项对比
重点：AI初始化流程、游戏创建流程、1 Player按钮流程
"""
import os
import sys
import re
import json
import urllib.request

if sys.platform == 'win32':
    sys.stdout.reconfigure(encoding='utf-8')
    sys.stderr.reconfigure(encoding='utf-8')

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
CDN_BASE = "https://cdn.tanktrouble.com/RELEASE-2026-05-11-01"
ORIGINAL_DIR = os.path.join(BASE_DIR, "original_js")
LOCAL_INDEX = os.path.join(BASE_DIR, "index.html")

def download_file(url, save_path=None):
    try:
        req = urllib.request.Request(url, headers={
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Accept': '*/*',
            'Referer': 'https://tanktrouble.com/'
        })
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = resp.read()
            if save_path:
                os.makedirs(os.path.dirname(save_path), exist_ok=True)
                with open(save_path, 'wb') as f:
                    f.write(data)
            return data.decode('utf-8', errors='ignore')
    except Exception as e:
        print(f"  [FAIL] {url}: {e}")
        return None

def extract_mod_vars(content):
    """从pagespeed JS文件中提取所有mod_pagespeed_*变量"""
    vars_found = {}
    # 匹配 var mod_pagespeed_XXX = "..."
    pattern = r'var (mod_pagespeed_\S+)\s*=\s*"((?:[^"\\]|\\.)*)"'
    for m in re.finditer(pattern, content):
        var_name = m.group(1)
        var_value = m.group(2).replace('\\"', '"').replace('\\n', '\n')
        vars_found[var_name] = var_value
    return vars_found

def find_function_body(code, func_pattern):
    """在代码中查找函数定义并提取其内容"""
    results = []
    for m in re.finditer(func_pattern, code):
        start = m.start()
        # 找到匹配的大括号
        brace_count = 0
        pos = code.find('{', start)
        if pos == -1:
            continue
        brace_count = 1
        end = pos + 1
        while end < len(code) and brace_count > 0:
            if code[end] == '{':
                brace_count += 1
            elif code[end] == '}':
                brace_count -= 1
            end += 1
        results.append(code[start:end])
    return results

def main():
    print("=" * 70)
    print("精准对比v3：原始游戏 vs 本地修改版")
    print("重点：AI流程、游戏创建流程、1 Player按钮流程")
    print("=" * 70)

    # ===== 步骤1：加载已下载的原始JS文件 =====
    print("\n[步骤1] 加载原始JS文件...")
    original_contents = {}
    if os.path.exists(ORIGINAL_DIR):
        for f in os.listdir(ORIGINAL_DIR):
            if f.endswith('.js'):
                fpath = os.path.join(ORIGINAL_DIR, f)
                with open(fpath, 'r', encoding='utf-8', errors='ignore') as fh:
                    original_contents[f] = fh.read()
                print(f"  [LOADED] {f} ({len(original_contents[f])} chars)")

    # 合并所有原始代码
    all_original = "\n".join(original_contents.values())

    # 提取所有mod_pagespeed变量
    all_mod_vars = {}
    for name, content in original_contents.items():
        vars_found = extract_mod_vars(content)
        all_mod_vars.update(vars_found)
    print(f"\n  提取到 {len(all_mod_vars)} 个mod_pagespeed变量")

    # ===== 步骤2：追踪AI完整流程 =====
    print("\n[步骤2] 追踪AI完整流程（从1 Player按钮到AI行动）")
    print("-" * 70)

    # 2a: 追踪 _onePlayer 方法
    print("\n--- 2a: UIMenuState._onePlayer ---")
    for var_name, var_code in all_mod_vars.items():
        if '_onePlayer' in var_code:
            # 提取_onePlayer方法
            match = re.search(r'_onePlayer:function\(\)(\{[^}]*\})', var_code)
            if match:
                print(f"  找到 _onePlayer 在 {var_name}:")
                print(f"  {match.group(0)[:500]}")
            else:
                # 更宽泛的搜索
                idx = var_code.find('_onePlayer')
                if idx >= 0:
                    print(f"  找到 _onePlayer 在 {var_name}:")
                    print(f"  ...{var_code[idx:idx+500]}...")

    # 2b: 追踪 Users.createGuests
    print("\n--- 2b: Users.createGuests ---")
    for var_name, var_code in all_mod_vars.items():
        if 'createGuests' in var_code and 'Users' in var_code:
            idx = var_code.find('createGuests')
            while idx >= 0:
                print(f"  找到 createGuests 在 {var_name}:")
                print(f"  ...{var_code[max(0,idx-100):idx+500]}...")
                idx = var_code.find('createGuests', idx + 1)
                if idx >= 0:
                    print()

    # 2c: 追踪 Backend.createGuests
    print("\n--- 2c: Backend.createGuests ---")
    for var_name, var_code in all_mod_vars.items():
        if 'createGuests' in var_code and 'Backend' in var_code:
            idx = var_code.find('createGuests')
            while idx >= 0:
                print(f"  找到 createGuests 在 {var_name}:")
                print(f"  ...{var_code[max(0,idx-100):idx+500]}...")
                idx = var_code.find('createGuests', idx + 1)

    # 2d: 追踪 AIs.addAIManager 调用链
    print("\n--- 2d: AIs.addAIManager 调用链 ---")
    for var_name, var_code in all_mod_vars.items():
        if 'addAIManager' in var_code:
            idx = var_code.find('addAIManager')
            while idx >= 0:
                print(f"  找到 addAIManager 在 {var_name}:")
                print(f"  ...{var_code[max(0,idx-200):idx+300]}...")
                idx = var_code.find('addAIManager', idx + 1)
                if idx >= 0:
                    print()

    # 2e: 追踪 AIs.getAvailableAIId 调用
    print("\n--- 2e: AIs.getAvailableAIId 调用 ---")
    for var_name, var_code in all_mod_vars.items():
        if 'getAvailableAIId' in var_code:
            idx = var_code.find('getAvailableAIId')
            while idx >= 0:
                print(f"  找到 getAvailableAIId 在 {var_name}:")
                print(f"  ...{var_code[max(0,idx-200):idx+300]}...")
                idx = var_code.find('getAvailableAIId', idx + 1)
                if idx >= 0:
                    print()

    # ===== 步骤3：分析游戏创建流程 =====
    print("\n[步骤3] 分析游戏创建流程")
    print("-" * 70)

    # 3a: GameController 创建
    print("\n--- 3a: GameController 创建 ---")
    for var_name, var_code in all_mod_vars.items():
        if 'GameController' in var_code and 'constructor' in var_code:
            idx = var_code.find('GameController')
            if idx >= 0:
                print(f"  找到 GameController 在 {var_name}:")
                print(f"  ...{var_code[idx:idx+300]}...")

    # 3b: GameController.addPlayer
    print("\n--- 3b: GameController.addPlayer ---")
    for var_name, var_code in all_mod_vars.items():
        if 'addPlayer' in var_code and ('GameController' in var_code or 'gameController' in var_code):
            idx = var_code.find('addPlayer')
            while idx >= 0:
                context = var_code[max(0,idx-100):idx+400]
                if 'gameController' in context.lower() or 'GameController' in context:
                    print(f"  找到 addPlayer 在 {var_name}:")
                    print(f"  ...{context}...")
                idx = var_code.find('addPlayer', idx + 1)

    # 3c: GameManager 相关
    print("\n--- 3c: GameManager ---")
    for var_name, var_code in all_mod_vars.items():
        if 'GameManager' in var_code and ('createGame' in var_code or 'addAI' in var_code):
            idx = var_code.find('GameManager')
            if idx >= 0:
                print(f"  找到 GameManager 在 {var_name}:")
                # 搜索createGame方法
                cg_idx = var_code.find('createGame', idx)
                if cg_idx >= 0:
                    print(f"  createGame: ...{var_code[cg_idx:cg_idx+500]}...")

    # ===== 步骤4：分析本地index.html补丁 vs 原始代码 =====
    print("\n[步骤4] 分析本地index.html补丁 vs 原始代码")
    print("-" * 70)

    if os.path.exists(LOCAL_INDEX):
        with open(LOCAL_INDEX, 'r', encoding='utf-8') as f:
            local_content = f.read()

        # 4a: 检查Ajax拦截是否正确
        print("\n--- 4a: Ajax拦截检查 ---")
        if 'TankTrouble.Ajax._call' in local_content:
            # 提取Ajax拦截代码
            ajax_start = local_content.find('TankTrouble.Ajax._call = function')
            if ajax_start >= 0:
                ajax_code = local_content[ajax_start:ajax_start+2000]
                print(f"  Ajax拦截代码片段:")
                print(f"  {ajax_code[:500]}...")

                # 检查关键method是否被拦截
                methods_to_check = [
                    'account.createGuests',
                    'tanktrouble.getAIs',
                    'tanktrouble.getPlayerDetails',
                    'tanktrouble.sprayPaint',
                    'tanktrouble.setColour',
                ]
                for method in methods_to_check:
                    if method in local_content:
                        print(f"  [OK] {method} 已拦截")
                    else:
                        print(f"  [MISSING] {method} 未拦截!")
        else:
            print("  [CRITICAL] Ajax._call 未被拦截!")

        # 4b: 检查AIs.init补丁
        print("\n--- 4b: AIs.init补丁检查 ---")
        if 'AIs.init' in local_content:
            idx = local_content.find('AIs.init')
            print(f"  AIs.init 补丁: ...{local_content[idx:idx+300]}...")
        else:
            print("  [MISSING] AIs.init 未补丁!")

        # 4c: 检查AIs.update循环
        print("\n--- 4c: AIs.update循环检查 ---")
        if 'AIs.update' in local_content:
            idx = local_content.find('AIs.update')
            print(f"  AIs.update 循环: ...{local_content[idx:idx+300]}...")
        else:
            print("  [MISSING] AIs.update 未设置循环!")

        # 4d: 检查AIManager相关
        print("\n--- 4d: AIManager相关检查 ---")
        if 'AIManager' in local_content:
            idx = local_content.find('AIManager')
            print(f"  AIManager: ...{local_content[idx:idx+300]}...")
        else:
            print("  [INFO] AIManager 未在补丁中（可能由原始JS提供）")

    # ===== 步骤5：深度分析 - 从原始代码提取完整AI流程 =====
    print("\n[步骤5] 深度分析 - 完整AI流程提取")
    print("-" * 70)

    # 提取UIMenuState._onePlayer完整代码
    print("\n--- 提取 _onePlayer 完整流程 ---")
    for var_name, var_code in all_mod_vars.items():
        if '_onePlayer' in var_code:
            # 找到_onePlayer方法并提取完整代码
            idx = var_code.find('_onePlayer:function')
            if idx >= 0:
                # 找到方法体
                brace_start = var_code.find('{', idx)
                brace_count = 1
                pos = brace_start + 1
                while pos < len(var_code) and brace_count > 0:
                    if var_code[pos] == '{':
                        brace_count += 1
                    elif var_code[pos] == '}':
                        brace_count -= 1
                    pos += 1
                method_code = var_code[idx:pos]
                print(f"  _onePlayer 完整代码 ({len(method_code)} chars):")
                print(f"  {method_code}")

    # 提取Users.createGuests完整代码
    print("\n--- 提取 Users.createGuests 完整流程 ---")
    for var_name, var_code in all_mod_vars.items():
        if 'createGuests' in var_code and 'Users' in var_code:
            # 搜索Users对象中的createGuests方法
            # 可能是 Users.createGuests 或 Users.methods中的createGuests
            idx = var_code.find('createGuests')
            while idx >= 0:
                # 向前查找上下文
                context_start = max(0, idx - 300)
                context = var_code[context_start:idx+800]
                if 'Users' in context[:300]:
                    print(f"  Users.createGuests 上下文:")
                    print(f"  {context[:600]}...")
                    break
                idx = var_code.find('createGuests', idx + 1)

    # ===== 步骤6：关键发现 - Ajax响应格式验证 =====
    print("\n[步骤6] Ajax响应格式验证")
    print("-" * 70)

    # 分析原始Ajax._call的success回调
    print("\n--- 原始Ajax._call success回调 ---")
    for var_name, var_code in all_mod_vars.items():
        if 'Ajax' in var_code and '_call' in var_code and 'jsonRPC' in var_code:
            idx = var_code.find('_call:function')
            if idx >= 0:
                # 提取_call方法
                brace_start = var_code.find('{', idx)
                brace_count = 1
                pos = brace_start + 1
                while pos < len(var_code) and brace_count > 0:
                    if var_code[pos] == '{':
                        brace_count += 1
                    elif var_code[pos] == '}':
                        brace_count -= 1
                    pos += 1
                call_method = var_code[idx:pos]
                print(f"  Ajax._call 完整代码 ({len(call_method)} chars):")
                print(f"  {call_method[:1000]}...")

    # 分析Backend.getAIs的回调格式
    print("\n--- Backend.getAIs 回调格式 ---")
    for var_name, var_code in all_mod_vars.items():
        if 'getAIs' in var_code and 'Backend' in var_code:
            idx = var_code.find('getAIs:function')
            if idx >= 0:
                brace_start = var_code.find('{', idx)
                brace_count = 1
                pos = brace_start + 1
                while pos < len(var_code) and brace_count > 0:
                    if var_code[pos] == '{':
                        brace_count += 1
                    elif var_code[pos] == '}':
                        brace_count -= 1
                    pos += 1
                getAIs_method = var_code[idx:pos]
                print(f"  Backend.getAIs 完整代码 ({len(getAIs_method)} chars):")
                print(f"  {getAIs_method}")

    # ===== 步骤7：分析main()函数 =====
    print("\n[步骤7] 分析main()函数")
    print("-" * 70)

    for var_name, var_code in all_mod_vars.items():
        if 'function main(' in var_code or 'function main ()' in var_code:
            idx = var_code.find('function main')
            if idx >= 0:
                brace_start = var_code.find('{', idx)
                brace_count = 1
                pos = brace_start + 1
                while pos < len(var_code) and brace_count > 0:
                    if var_code[pos] == '{':
                        brace_count += 1
                    elif var_code[pos] == '}':
                        brace_count -= 1
                    pos += 1
                main_func = var_code[idx:pos]
                print(f"  main() 完整代码 ({len(main_func)} chars):")
                print(f"  {main_func[:2000]}...")

    # ===== 步骤8：检查本地JS文件是否完整 =====
    print("\n[步骤8] 检查本地JS文件完整性")
    print("-" * 70)

    local_js_dir = os.path.join(BASE_DIR, "js")
    if os.path.exists(local_js_dir):
        local_js_files = [f for f in os.listdir(local_js_dir) if f.endswith('.js')]
        print(f"  本地JS文件数量: {len(local_js_files)}")

        # 检查关键JS文件是否存在
        critical_checks = {
            'AIs': False,
            'AIManager': False,
            'AI.update': False,
            'InputState': False,
            'GameController': False,
            'GameModel': False,
            'RoundController': False,
            'Backend': False,
            'Users': False,
            'GameManager': False,
        }

        for js_file in local_js_files:
            fpath = os.path.join(local_js_dir, js_file)
            try:
                with open(fpath, 'r', encoding='utf-8', errors='ignore') as fh:
                    content = fh.read()
                for key in critical_checks:
                    if key in content:
                        critical_checks[key] = True
            except:
                pass

        for key, found in critical_checks.items():
            status = "[OK]" if found else "[MISSING]"
            print(f"  {status} {key}")

    # ===== 步骤9：总结关键发现 =====
    print("\n" + "=" * 70)
    print("总结：关键发现")
    print("=" * 70)

    # 检查本地index.html中的Ajax拦截返回格式
    if os.path.exists(LOCAL_INDEX):
        with open(LOCAL_INDEX, 'r', encoding='utf-8') as f:
            local_content = f.read()

        print("\n--- Ajax响应格式分析 ---")
        # 查找构造result的代码
        result_pattern = r'var result\s*=\s*\{[^}]+\}'
        for m in re.finditer(result_pattern, local_content):
            print(f"  result构造: {m.group(0)[:200]}")

        # 检查successfn调用
        success_pattern = r'successfn\([^)]+\)'
        for m in re.finditer(success_pattern, local_content):
            print(f"  successfn调用: {m.group(0)[:200]}")

        print("\n--- 关键问题诊断 ---")
        # 检查是否缺少 _unwrapAchievementUnlocksFromData 调用
        if '_unwrapAchievementUnlocksFromData' not in local_content:
            print("  [WARN] Ajax拦截未调用 _unwrapAchievementUnlocksFromData")
        else:
            print("  [OK] _unwrapAchievementUnlocksFromData 已调用")

        # 检查completefn是否被正确调用
        if 'completefn' in local_content:
            print("  [OK] completefn 已处理")
        else:
            print("  [WARN] completefn 未处理")

        # 检查AIs.addAIManager是否在游戏流程中被调用
        if 'addAIManager' in local_content:
            print("  [OK] addAIManager 在补丁中")
        else:
            print("  [CRITICAL] addAIManager 不在补丁中 - 需要检查游戏流程是否自动调用")

        # 检查游戏创建后是否添加AI
        print("\n--- 游戏创建后AI添加流程 ---")
        # 搜索原始代码中addAIManager的调用上下文
        for var_name, var_code in all_mod_vars.items():
            if 'addAIManager' in var_code:
                idx = var_code.find('addAIManager')
                while idx >= 0:
                    context = var_code[max(0,idx-300):idx+200]
                    print(f"  在 {var_name} 中:")
                    print(f"  ...{context}...")
                    idx = var_code.find('addAIManager', idx + 1)
                    if idx >= 0:
                        print()

if __name__ == '__main__':
    main()
