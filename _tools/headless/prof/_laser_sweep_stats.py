# -*- coding: utf-8 -*-
"""激光 vs 坦克：点采样 vs 线段扫掠 的几何统计（离线计算；只读产品常量，不碰产品代码）

几何模型 = 游戏真实夹具（探针 __vtTankShape('tank_b') 实测读回，逐位吻合）：
  车体 3.0 x 4.0（局部中心 (0,0)）+ 炮塔 0.7 x 1.4（局部中心 (0,-2.0)）
激光：速度 180 m/s、帧长 1/60 s ⇒ 每帧位移 = 3.0 m（= TANK.WIDTH 3.0 m）
参数化（把坦克放到局部系、激光线用"法向角+垂距"参数）：
  a = 激光方向与坦克局部 x 轴的夹角；u=(cos a,sin a)，n=(-sin a,cos a)
  直线 = { t*u + h*n }；h 在"与轮廓相交"的区间内均匀（直线空间自然测度）
  采样点 = 相邻两帧位置 = 格点 {φ+3k}；取跨过坦克的那一对 (φ-3, φ)，φ∈[-3,0)
判据：
  【应命中】线段 (φ-3)→φ 与轮廓（车体∪炮塔）真正相交  ← 这正是游戏 Box2D CCD/TOI 干的事
  【点采样漏】两端采样点与轮廓的距离都 > r（r = 采样圆的半径：融合/geoHit 用 0.05，旧 checkDeath 用 0.25）
"""
import numpy as np, json, io, os

BODY = (-1.5, 1.5, -2.0, 2.0)
TUR  = (-0.35, 0.35, -2.7, -1.3)
STEP = 3.0
NA, NH, NT = 180, 61, 90          # 角度 1°, 垂距 61, 相位 90

def seg_rect(px, py, dx, dy, rect):
    xmin, xmax, ymin, ymax = rect
    t0, t1 = 0.0, 1.0
    for (p, d, lo, hi) in ((px, dx, xmin, xmax), (py, dy, ymin, ymax)):
        if abs(d) < 1e-12:
            if p < lo or p > hi: return (False, 0.0, 0.0)
        else:
            a, b = (lo - p) / d, (hi - p) / d
            if a > b: a, b = b, a
            t0 = max(t0, a); t1 = min(t1, b)
            if t0 > t1: return (False, 0.0, 0.0)
    return (True, t0, t1)

def pt_rect(px, py, rect):
    xmin, xmax, ymin, ymax = rect
    dx = max(xmin - px, 0.0, px - xmax); dy = max(ymin - py, 0.0, py - ymax)
    return (dx * dx + dy * dy) ** 0.5

RS = (0.0, 0.01, 0.05, 0.25)
miss = {r: 0 for r in RS}
tot_hit = 0; tot_cfg = 0
nBodyOnly = 0; nTurOnly = 0; nBoth = 0
chord_hist = {b: 0 for b in ('<1', '1-2', '2-3', '>=3')}
miss_by_bucket = {r: {b: 0 for b in chord_hist} for r in RS}
bucket_tot = dict(chord_hist)
maxSampleToCenter = 0.0; worst = None
maxSampleToGeom = 0.0; worstG = None
scale = STEP / 1.0

for a in np.linspace(0.0, np.pi, NA, endpoint=False):
    ux, uy = np.cos(a), np.sin(a); nx, ny = -uy, ux
    hrad = 0.0
    for R in (BODY, TUR):
        for (x, y) in ((R[0], R[2]), (R[0], R[3]), (R[1], R[2]), (R[1], R[3])):
            hrad = max(hrad, abs(nx * x + ny * y))
    for h in np.linspace(-hrad, hrad, NH):
        for t0 in np.linspace(-STEP, 0.0, NT, endpoint=False):
            tot_cfg += 1
            px = t0 * ux + h * nx; py = t0 * uy + h * ny
            dx, dy = ux * STEP, uy * STEP
            hb = seg_rect(px, py, dx, dy, BODY)
            ht = seg_rect(px, py, dx, dy, TUR)
            chordB = (hb[2] - hb[1]) * STEP if hb[0] else 0.0
            chordT = (ht[2] - ht[1]) * STEP if ht[0] else 0.0
            chord = max(chordB, chordT)
            if chord <= 1e-9:  continue
            tot_hit += 1
            if chordB > 1e-9 and chordT > 1e-9: nBoth += 1
            elif chordB > 1e-9: nBodyOnly += 1
            else: nTurOnly += 1
            b = '<1' if chord < 1 else ('1-2' if chord < 2 else ('2-3' if chord < 3 else '>=3'))
            bucket_tot[b] += 1
            e1x, e1y = px, py
            e2x, e2y = px + dx, py + dy
            d1 = min(pt_rect(e1x, e1y, BODY), pt_rect(e1x, e1y, TUR))
            d2 = min(pt_rect(e2x, e2y, BODY), pt_rect(e2x, e2y, TUR))
            for r in RS:
                if d1 > r and d2 > r:
                    miss[r] += 1; miss_by_bucket[r][b] += 1
            mn = min(d1, d2)
            if mn > maxSampleToGeom:
                maxSampleToGeom = mn; worstG = (round(float(a), 3), round(float(h), 3), round(float(t0), 3), round(float(d1), 3), round(float(d2), 3), round(float(chord), 3))
            c1 = (e1x * e1x + e1y * e1y) ** 0.5; c2 = (e2x * e2x + e2y * e2y) ** 0.5
            mnc = min(c1, c2)
            if mnc > maxSampleToCenter:
                maxSampleToCenter = mnc; worst = (round(float(a), 3), round(float(h), 3), round(float(t0), 3), round(float(c1), 3), round(float(c2), 3), round(float(chord), 3))

out = []
out.append('配置总数 = %d，线段与坦克相交 = %d (%.1f%%)' % (tot_cfg, tot_hit, 100.0 * tot_hit / tot_cfg))
out.append('相交的构成：只穿车体 %d (%.1f%%) / 只穿炮塔 %d (%.1f%%) / 两者都穿 %d (%.1f%%)' % (
    nBodyOnly, 100.0 * nBodyOnly / tot_hit, nTurOnly, 100.0 * nTurOnly / tot_hit, nBoth, 100.0 * nBoth / tot_hit))
out.append('弦长分布：<1m %.1f%% / 1~2m %.1f%% / 2~3m %.1f%% / ≥3m %.1f%%' % tuple(
    100.0 * bucket_tot[b] / tot_hit for b in ('<1', '1-2', '2-3', '>=3')))
out.append('')
out.append('★ 点采样漏判率（条件 = 激光线与坦克几何相交）')
for r in RS:
    out.append('   r=%.2f m → %d/%d = %.2f%%   （按弦长：<1m %.1f%% / 1~2m %.1f%% / 2~3m %.1f%% / ≥3m %.1f%%）' % (
        r, miss[r], tot_hit, 100.0 * miss[r] / tot_hit,
        *[100.0 * miss_by_bucket[r][b] / bucket_tot[b] for b in ('<1', '1-2', '2-3', '>=3')]))
out.append('')
out.append('样本点离几何最远（相交配置里 max of min(d1,d2)）= %.3f m（>0.05 就有漏判可能）' % maxSampleToGeom)
out.append('  最坏配置 (a,h,t0,d1,d2,chord) = %s' % (worstG,))
out.append('')
out.append('★ checkDeath 预筛半径（坦克中心为圆心）：相交配置里 max of min(两采样点到车心) = %.3f m' % maxSampleToCenter)
out.append('  最坏配置 (a,h,t0,|S1|,|S2|,chord) = %s' % (worst,))
out.append('  ⇒ 预筛半径 %.4f m %s' % (3.4887, ('> 该值 ⇒ 预筛不可能把"激光跨过坦克"筛掉' if 3.4887 > maxSampleToCenter else '可能筛掉一部分')))
txt = '\n'.join(out)
io.open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'laser_sweep_stats.txt'), 'w', encoding='utf-8').write(txt + '\n')
print(txt)
