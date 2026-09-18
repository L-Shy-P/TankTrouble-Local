# -*- coding: utf-8 -*-
"""
修复mod_pagespeed包装的JS文件
将字符串变量转换为可执行代码
"""
import os
import re

JS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'js')

def fix_js_file(filepath):
    """修复单个JS文件"""
    with open(filepath, 'r', encoding='utf-8', errors='replace') as f:
        content = f.read()

    # 查找所有JS文件内部的eval语句（这些会导致依赖问题）
    # 格式: eval(mod_pagespeed_XXX);
    # 注意：这些eval语句可能紧跟在变量定义后面，如: eval(mod_pagespeed_xxx);var mod_pagespeed_yyy = ...
    pattern = r'eval\(mod_pagespeed_\w+\);'

    matches = list(re.finditer(pattern, content))

    if not matches:
        return False

    # 从后往前移除，避免位置偏移
    for match in reversed(matches):
        content = content[:match.start()] + content[match.end():]

    # 保存修复后的文件
    with open(filepath, 'w', encoding='utf-8') as f:
        f.write(content)

    return True

def fix_all_js_files():
    """修复所有JS文件"""
    if not os.path.exists(JS_DIR):
        print(f"错误: 找不到 {JS_DIR} 目录")
        return

    fixed_count = 0
    error_count = 0

    for filename in os.listdir(JS_DIR):
        if not filename.endswith('.js'):
            continue

        filepath = os.path.join(JS_DIR, filename)
        print(f"处理: {filename}")

        try:
            if fix_js_file(filepath):
                print(f"  [OK] 已修复")
                fixed_count += 1
            else:
                print(f"  [--] 无需修复")
        except Exception as e:
            print(f"  [X] 错误: {e}")
            error_count += 1

    print(f"\n完成: 修复了 {fixed_count} 个文件, {error_count} 个错误")

if __name__ == '__main__':
    fix_all_js_files()
