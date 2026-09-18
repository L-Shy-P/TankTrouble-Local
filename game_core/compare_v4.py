# -*- coding: utf-8 -*-
"""
精准对比v4：重点追踪 _addGuests 和游戏创建流程
找出AI为何不被添加
"""
import os
import sys
import re

if sys.platform == 'win32':
    sys.stdout.reconfigure(encoding='utf-8')
    sys.stderr.reconfigure(encoding='utf-8')

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
ORIGINAL_DIR = os.path.join(BASE_DIR, "original_js")
LOCAL_INDEX = os.path.join(BASE_DIR, "index.html")
LOCAL_JS_DIR = os.path.join(BASE_DIR, "js")

def extract_mod_vars_from_file(filepath):
    """从JS文件中提取所有mod_pagespeed_*变量"""
    with open(filepath, 'r', encoding='utf-8', errors='ignore') as f:
        content = f.read()
    vars_found = {}
    pattern = r'var (mod_pagespeed_\S+)\s*=\s*"((?:[^"\\]|\\.)*)"'
    for m in re.finditer(pattern, content):
        var_name = m.group(1)
        var_value = m.group(2).replace('\\"', '"').replace('\\n', '\n')
        vars_found[var_name] = var_value
    return vars_found

def find_method(code, method_name, context_chars=500):
    """在代码中查找方法定义并提取上下文"""
    results = []
    # 搜索各种可能的方法定义模式
    patterns = [
        method_name + ':function(',
        method_name + ': function(',
        method_name + '=function(',
        'function ' + method_name + '(',
        '.' + method_name + '=function(',
    ]
    for pattern in patterns:
        idx = 0
        while True:
            idx = code.find(pattern, idx)
            if idx == -1:
                break
            # 提取方法体（匹配大括号）
            brace_start = code.find('{', idx)
            if brace_start == -1:
                idx += len(pattern)
                continue
            brace_count = 1
            pos = brace_start + 1
            while pos < len(code) and brace_count > 0:
                if code[pos] == '{':
                    brace_count += 1
                elif code[pos] == '}':
                    brace_count -= 1
                pos += 1
            method_code = code[idx:pos]
            results.append(method_code)
            idx += len(pattern)
    return results

def main():
    print("=" * 70)
    print("精准对比v4：追踪 _addGuests 和游戏创建流程")
    print("=" * 70)

    # 加载所有本地JS文件中的mod_pagespeed变量
    print("\n[步骤1] 加载本地JS文件中的所有mod_pagespeed变量...")
    all_mod_vars = {}
    if os.path.exists(LOCAL_JS_DIR):
        for f in os.listdir(LOCAL_JS_DIR):
            if f.endswith('.js'):
                fpath = os.path.join(LOCAL_JS_DIR, f)
                vars_found = extract_mod_vars_from_file(fpath)
                if vars_found:
                    print(f"  {f}: {len(vars_found)} 个变量")
                    all_mod_vars.update(vars_found)

    print(f"\n  总共 {len(all_mod_vars)} 个mod_pagespeed变量")

    # ===== 步骤2：追踪 _addGuests 方法 =====
    print("\n[步骤2] 追踪 _addGuests 方法")
    print("-" * 70)

    for var_name, var_code in all_mod_vars.items():
        methods = find_method(var_code, '_addGuests')
        if methods:
            for method in methods:
                print(f"\n  在 {var_name} 中找到 _addGuests:")
                print(f"  {method[:1000]}")
                if len(method) > 1000:
                    print(f"  ... (共 {len(method)} chars)")

    # ===== 步骤3：追踪游戏创建流程 =====
    print("\n[步骤3] 追踪游戏创建流程（createLocalGame等）")
    print("-" * 70)

    for var_name, var_code in all_mod_vars.items():
        for search_term in ['createLocalGame', 'createNewGame', '_startLocalGame', 'startLocal']:
            methods = find_method(var_code, search_term)
            if methods:
                for method in methods:
                    print(f"\n  在 {var_name} 中找到 {search_term}:")
                    print(f"  {method[:1500]}")
                    if len(method) > 1500:
                        print(f"  ... (共 {len(method)} chars)")

    # ===== 步骤4：追踪 AIs.isReady 和 AIs.addAIManager 的调用 =====
    print("\n[步骤4] 追踪 AIs.isReady 和 AIs.addAIManager 调用")
    print("-" * 70)

    for var_name, var_code in all_mod_vars.items():
        if 'AIs.isReady' in var_code or 'AIs.addAIManager' in var_code:
            # 找到所有调用位置
            for search_term in ['AIs.isReady', 'AIs.addAIManager', 'AIs.getAvailableAIId']:
                idx = 0
                while True:
                    idx = var_code.find(search_term, idx)
                    if idx == -1:
                        break
                    context = var_code[max(0,idx-200):idx+300]
                    print(f"\n  在 {var_name} 中 {search_term} 调用:")
                    print(f"  ...{context}...")
                    idx += len(search_term)

    # ===== 步骤5：追踪 Users.createGuests 和 Users._addGuests =====
    print("\n[步骤5] 追踪 Users 相关方法")
    print("-" * 70)

    for var_name, var_code in all_mod_vars.items():
        if 'Users' in var_code:
            for search_term in ['createGuests', '_addGuests', 'addGuest', 'getAllPlayerIds']:
                methods = find_method(var_code, search_term)
                if methods:
                    for method in methods:
                        if 'Users' in method[:200] or 'users' in method[:200].lower():
                            print(f"\n  在 {var_name} 中找到 {search_term}:")
                            print(f"  {method[:1000]}")

    # ===== 步骤6：追踪 main() 函数中 AIs.init 的调用 =====
    print("\n[步骤6] 追踪 main() 中 AIs.init 调用")
    print("-" * 70)

    for var_name, var_code in all_mod_vars.items():
        if 'AIs.init' in var_code:
            idx = 0
            while True:
                idx = var_code.find('AIs.init', idx)
                if idx == -1:
                    break
                context = var_code[max(0,idx-200):idx+300]
                print(f"\n  在 {var_name} 中 AIs.init 调用:")
                print(f"  ...{context}...")
                idx += 8

    # ===== 步骤7：检查本地JS文件中AI相关代码是否完整 =====
    print("\n[步骤7] 检查本地JS中AI相关代码完整性")
    print("-" * 70)

    ai_keywords = [
        'AIs.classMethods',
        'AIs.init',
        'AIs.addAIManager',
        'AIs.removeAIManager',
        'AIs.update',
        'AIs.getAvailableAIId',
        'AIs.isReady',
        'AIManager.create',
        'AIManager.update',
        'AI.constructor',
        'AI.update',
        'AI._updateState',
        'AI._makeDecisionsAndUpdateGoal',
        'AI._updateActionsToAchieveGoal',
        'AI._updateInputToDoAction',
        'InputState.withState',
        'InputState.create',
    ]

    for keyword in ai_keywords:
        found_in = []
        for var_name, var_code in all_mod_vars.items():
            if keyword in var_code:
                found_in.append(var_name)
        if found_in:
            print(f"  [OK] {keyword} -> {found_in}")
        else:
            print(f"  [MISSING] {keyword}")

    # ===== 步骤8：检查本地index.html中eval语句是否包含AI相关变量 =====
    print("\n[步骤8] 检查index.html中AI相关eval语句")
    print("-" * 70)

    if os.path.exists(LOCAL_INDEX):
        with open(LOCAL_INDEX, 'r', encoding='utf-8') as f:
            local_content = f.read()

        # 提取所有eval语句
        eval_pattern = r'eval\((mod_pagespeed_\S+)\)'
        eval_vars = re.findall(eval_pattern, local_content)
        print(f"  index.html中共有 {len(eval_vars)} 个eval语句")

        # 检查AI相关的eval变量
        ai_var_names = ['mod_pagespeed_AnJvKIxLY$', 'mod_pagespeed_tjvCFwSawu', 'mod_pagespeed_yn3b9X4$VY']
        for var_name in ai_var_names:
            if var_name in local_content:
                print(f"  [OK] {var_name} 在index.html中")
            else:
                print(f"  [MISSING] {var_name} 不在index.html中!")

        # 检查这些变量是否在本地JS文件中定义
        for var_name in ai_var_names:
            if var_name in all_mod_vars:
                print(f"  [OK] {var_name} 在本地JS文件中定义 ({len(all_mod_vars[var_name])} chars)")
            else:
                print(f"  [MISSING] {var_name} 不在本地JS文件中!")

    # ===== 步骤9：关键诊断 =====
    print("\n" + "=" * 70)
    print("关键诊断：AI为何不工作")
    print("=" * 70)

    # 检查AIs.init是否被正确调用
    print("\n--- AIs.init 调用链 ---")
    print("  1. main() -> AIs.init()")
    print("  2. AIs.init() -> Backend.getInstance().getAIs(callback)")
    print("  3. Backend.getAIs -> Ajax.getAIs -> Ajax._call('tanktrouble.getAIs')")
    print("  4. 我们的Ajax拦截返回: { result: { result: true, data: [...] } }")
    print("  5. Backend.getAIs callback: result.result.result -> successfn(result.result.data)")
    print("  6. AIs.init callback: Array.isArray(result) -> AIs.ais[result[i].playerId] = result[i].config")

    # 检查游戏创建时AI添加流程
    print("\n--- 游戏创建时AI添加流程 ---")
    print("  1. 用户点击 '1 Player' -> _addGuests(1)")
    print("  2. Users.createGuests(1, callback)")
    print("  3. 创建GameController")
    print("  4. 添加所有playerIds到游戏")
    print("  5. if(playerIds.length <= 1) {")
    print("  6.   if(AIs.isReady()) {")
    print("  7.     var aiId = AIs.getAvailableAIId(ttGame.getId());")
    print("  8.     if(aiId) { AIs.addAIManager(ttGame, aiId); ttGame.addPlayer(aiId); }")
    print("  9.   }")
    print("  10. }")

    # 诊断可能的问题
    print("\n--- 可能的问题 ---")

    # 检查AIs.ais的数据格式
    print("\n  问题1: AIs.ais数据格式")
    print("  原始代码期望: AIs.ais[playerId] = config")
    print("  我们的Ajax返回: [{playerId: 'ai_laika', config: {name: 'Laika', difficulty: 'medium'}}]")
    print("  AIs.init遍历: AIs.ais[result[i].playerId] = result[i].config")
    print("  结果: AIs.ais = {'ai_laika': {name: 'Laika', difficulty: 'medium'}, ...}")
    print("  AI.create期望config包含什么?")

    # 检查AI.create的config参数
    for var_name, var_code in all_mod_vars.items():
        if 'AI.constructor' in var_code or 'AI.create' in var_code:
            idx = var_code.find('AI.constructor')
            if idx >= 0:
                context = var_code[idx:idx+500]
                print(f"\n  AI.constructor 代码 ({var_name}):")
                print(f"  {context}")
                break

    # 检查AIManager.create的参数
    for var_name, var_code in all_mod_vars.items():
        if 'AIManager.constructor' in var_code:
            idx = var_code.find('AIManager.constructor')
            if idx >= 0:
                context = var_code[idx:idx+500]
                print(f"\n  AIManager.constructor 代码 ({var_name}):")
                print(f"  {context}")
                break

    # 检查AIs.update的实现
    print("\n  问题2: AIs.update 实现")
    for var_name, var_code in all_mod_vars.items():
        if 'AIs.update' in var_code and 'AIs.classMethods' in var_code:
            idx = var_code.find('AIs.update')
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
                method = var_code[idx:pos]
                print(f"  AIs.update 代码 ({var_name}):")
                print(f"  {method}")
                break

if __name__ == '__main__':
    main()
