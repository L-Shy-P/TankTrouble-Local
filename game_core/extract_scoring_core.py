# -*- coding: utf-8 -*-
"""
程序化抽取：把 ai_tactics.js 里的「遮蔽角/旋转余量包络成品系统」逐字节拷贝进
vantage_scoring.js。不手抄，直接按行切片，带锚点断言防止行号漂移。
"""
import io, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, 'js', 'ai_tactics.js')
DST = os.path.join(HERE, 'js', 'vantage_scoring.js')

with io.open(SRC, 'r', encoding='utf-8') as f:
    lines = f.read().split('\n')

def block(start, end):
    # 1-indexed inclusive
    return '\n'.join(lines[start-1:end])

# 行号区间（已人工核对）+ 锚点断言
ranges = [
    # (起, 止, 首行应含, 块内应含的关键函数)
    (8,    43,   'function getCfg',                 ['DEFAULT_BEHAVIOR']),
    (3489, 3599, 'function getTankHalfWidth',       ['function getTankHullHalfExtents', 'function getBulletBodyRadius', 'function getTankMaxDiagonal']),
    (4704, 4716, 'function minDistancePointToSegment', []),
    (4744, 5027, 'var TWO_PI',                      ['function marginEnvelopeOverRotation', 'function classifyPointRotationZones', 'function getTankHeptagonLocal', 'function combinedMarginAtRotation', 'function marginHeptagonAtRotation']),
]

blocks = []
for (s, e, first_anchor, must_contain) in ranges:
    b = block(s, e)
    first_line = lines[s-1]
    if first_anchor not in first_line:
        print('ABORT: 行 %d 首行不含锚点 %r，实际=%r' % (s, first_anchor, first_line))
        sys.exit(1)
    for kw in must_contain:
        if kw not in b:
            print('ABORT: 区间 %d-%d 缺少 %r' % (s, e, kw))
            sys.exit(1)
    blocks.append(b)

header = u"""/**
 * Vantage 评分与基准时间模块（阶段②）
 *
 * 「拷贝区」内的函数为逐字节复制自 js/ai_tactics.js 的成品几何系统
 * （旋转余量包络 = 调试器 F8 安全区背后的遮蔽角计算），请勿手改。
 * 来源行区间（ai_tactics.js）：
 *   getCfg/DEFAULT_BEHAVIOR      L8-43
 *   坦克尺寸/子弹半径            L3489-3599
 *   点到线段距离                 L4704-4716
 *   旋转余量包络几何核心         L4744-5027
 * 拷贝区依赖游戏全局 Constants（游戏是唯一权威），在游戏页/测试 iframe 内均可用。
 */
(function(global) {
    'use strict';

    // ==================== 拷贝区开始（ai_tactics.js 逐字节复制，勿手改） ====================
"""

footer = u"""
    // ==================== 拷贝区结束 ====================

    // __VANTAGE_SCORING_LAYERS__

})(typeof window !== 'undefined' ? window : this);
"""

out = header + '\n'.join(blocks) + footer
with io.open(DST, 'w', encoding='utf-8', newline='\n') as f:
    f.write(out)

print('OK: 已生成 %s，共 %d 行' % (DST, out.count('\n') + 1))
for i, (s, e, _, _) in enumerate(ranges):
    print('  块%d: L%d-%d (%d 行)' % (i + 1, s, e, e - s + 1))
