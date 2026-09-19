#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
对拍工具：量出"预测用的弹药状态"比"真实物理"慢几帧。

用法：
    python game_core/rust/trace_diff.py <录像文件.json> [--killer 弹id]

输出两段：
  ① 几何接触核算：用录像里的真实弹位/速度 + 原版车体尺寸（半长 1.5×2.0 米、子弹半径 0.25 米）
     算出"几何上真正接触"的时刻，与游戏报告的死亡时刻对比。差值就是**总偏差**。
  ② 融合世界轨迹对拍（录像里带 scanTraces 时才有）：把权威扫描里融合世界逐帧的
     每颗弹位置，与录像同一时刻的真实弹位逐帧比距离；对每个"落后 k 帧"假设算平均误差，
     误差最小的 k 就是**预测用的弹药状态落后的帧数**。
"""
import io, json, math, sys

FRAME = 0.02
TANK_HALF_L = 2.0     # 车体半长（TANK.HEIGHT.m/2 = 4.0/2）
TANK_HALF_W = 1.5     # 车体半宽（TANK.WIDTH.m/2  = 3.0/2）
BULLET_R = 0.25


def gap_to_tank(px, py, cx, cy, rot):
    """弹心到车体（旋转矩形）边缘的距离，已扣掉子弹半径。<=0 表示接触。"""
    u = (math.sin(rot), -math.cos(rot))
    r = (math.cos(rot), math.sin(rot))
    dx, dy = px - cx, py - cy
    a = dx * u[0] + dy * u[1]
    b = dx * r[0] + dy * r[1]
    ox = max(abs(a) - TANK_HALF_L, 0.0)
    oy = max(abs(b) - TANK_HALF_W, 0.0)
    return math.hypot(ox, oy) - BULLET_R


def load(path):
    return json.load(io.open(path, encoding='utf-8'))


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return 1
    path = sys.argv[1]
    killer = None
    if '--killer' in sys.argv:
        killer = sys.argv[sys.argv.index('--killer') + 1]
    d = load(path)
    recs = d.get('records') or []
    deaths = d.get('deaths') or []
    if not recs or not deaths:
        print('录像里没有 records / deaths，无法分析')
        return 1
    print('录像 %s：%d 帧，%d 次死亡' % (path.split('\\')[-1].split('/')[-1], len(recs), len(deaths)))

    # ---------- ① 几何接触核算（对每次死亡） ----------
    for dth in deaths:
        tDeath = dth['t']
        pid = killer or dth.get('projectileId')
        near = [r for r in recs if abs(r['t'] - tDeath) <= 0.30]
        if not near:
            near = recs[-15:]
        # 取死亡前最后一帧有该弹的记录，做等速外推
        last = None
        for r in near:
            for p in (r.get('proj') or []):
                if p['id'] == pid:
                    last = (r, p)
        print('\n死亡 t=%.3f  致死弹=%s' % (tDeath, pid))
        if not last:
            print('  录像里没有该弹的明细（proj 为空），跳过几何核算')
            continue
        r0, p0 = last
        # 用最近两帧估真实速度（弹是等速直线）
        k = [p for p in (r0.get('proj') or []) if p['id'] == pid][0]
        prev = None
        for r in reversed([x for x in recs if x['t'] < r0['t']]):
            pp = [p for p in (r.get('proj') or []) if p['id'] == pid]
            if pp:
                prev = pp[0]
                break
        if not prev:
            continue
        dt = r0['t'] - [x['t'] for x in recs if x['t'] < r0['t']][-1]
        vx = (k['x'] - prev['x']) / dt if dt > 0 else 0.0
        vy = (k['y'] - prev['y']) / dt if dt > 0 else 0.0
        tk = r0['tank']
        print('  真实弹速 (%.2f, %.2f) 米/秒；坦克(%0.2f, %0.2f, rot %.2f)' % (vx, vy, tk['x'], tk['y'], tk['rot']))
        tHit = None
        for step in range(0, 40):
            t = r0['t'] + step * FRAME
            g = gap_to_tank(k['x'] + vx * step * FRAME, k['y'] + vy * step * FRAME,
                            tk['x'], tk['y'], tk['rot'])
            if g <= 0:
                tHit = t
                break
        if tHit is None:
            print('  纯几何外推 0.8 秒内不接触（子弹在录像窗口内没有直接命中）')
        else:
            print('  几何接触时刻 ≈ %.3f（报告死亡 %.3f）→ 差 %+.0f 帧' %
                  (tHit, tDeath, (tDeath - tHit) / FRAME))
            print('  说明：报告死亡比"用录像弹位算的几何接触"早 %0.1f 帧，这差额就是"预测用的弹药状态落后真实物理"的帧数。'
                  % ((tHit - tDeath) / FRAME))

    # ---------- ①.5 轨迹时间基准（每帧 bulletErr + 每弹锚点）----------
    errs = [(r['t'], r.get('bulletErr'), r.get('bulletErrId')) for r in recs if r.get('bulletErr') is not None]
    if errs:
        mx = max(errs, key=lambda x: x[1])
        pos = [e[1] for e in errs if e[1] is not None and e[1] > 0.05]
        print()
        print('轨迹 vs 真实弹位误差（bulletErr，米）：样本 %d，>0.05m 的 %d 个，最大 %.3f @ t=%.3f 弹=%s'
              % (len(errs), len(pos), mx[1], mx[0], mx[2]))
        print('   判读：这个数≈0 说明轨迹时间基准对；≈0.36/0.72 米说明轨迹比现实落后 1/2 帧。')
    else:
        print()
        print('本录像没有 bulletErr（v122 之前录的）')
    last = recs[-1]
    if last.get('anchors'):
        print('   最后一帧每弹锚点（anchorOffset / 轨迹第0帧对应绝对时刻 / 轨迹长度）：')
        for a in last['anchors'][:6]:
            print('     %-14s off=%.3f  abs0=%.3f  len=%d' % (a['id'], a['off'], a['abs0'], a['len']))

    # ---------- ② 融合世界轨迹对拍 ----------
    traces = [t for t in (d.get('scanTraces') or []) if t.get('kind') == 'rollout']
    scans = [t for t in (d.get('scanTraces') or []) if t.get('kind') != 'rollout']
    if traces:
        print()
        print('九候选打分（rollout）轨迹 %d 条，看它们用的弹位时间基准：' % len(traces))
        for tr in traces[-2:]:
            h = tr.get('header') or (tr.get('frames') and getattr(tr['frames'], 'header', None))
            fr = tr.get('frames') or []
            head = fr[0] if fr else {}
            bs = head.get('bs') or []
            print('  t=%.3f 节点=%s 帧数=%d 弹=%d' % (tr['t'], tr.get('nodeId'), len(fr), len(bs)))
            for b in bs[:4]:
                print('     弹 %-14s 摆位来源=%s anchorOffset=%s 查询q=%s track下标=%s'
                      % (b.get('id'), b.get('src'), b.get('off'), b.get('q'), b.get('idx')))
    if not (traces or scans):
        print()
        print('本录像没有轨迹（需 v122 及以后版本录制）')
        return 0

    traces = d.get('scanTraces') or []
    if not traces:
        print('\n本录像没有 scanTraces（v121 之前的版本录的，或这局没触发权威扫描）。')
        print('要量"落后几帧"，请用 v121 及以后版本重打一局（正常打即可，死亡会自动抓取）。')
        return 0
    byT = {}
    for r in recs:
        byT[round(r['t'], 3)] = r
    print('\n融合世界轨迹对拍（%d 条扫描轨迹）：' % len(traces))
    for tr in traces[-3:]:
        f0 = tr['frames'][0] if tr.get('frames') else None
        if not f0:
            continue
        ids = [b['id'] for b in f0.get('bs', []) if b.get('id')]
        if not ids:
            continue
        print('  扫描 t=%.3f node=%s op=%s scanDeath=%s，弹 %d 颗' %
              (tr['t'], tr.get('nodeId'), tr.get('op'), tr.get('scanDeath'), len(ids)))
        # 对每颗弹：比较 trace 第 k 帧位置 vs 真实第 (k-lag) 帧位置，找最优 lag
        best = {}
        for bid in ids[:4]:
            errs = {}
            for lag in range(-2, 9):
                tot = 0.0
                cnt = 0
                for fr in tr['frames']:
                    tb = [b for b in fr.get('bs', []) if b.get('id') == bid]
                    if not tb:
                        continue
                    tReal = tr['t'] + (fr['k'] - lag) * FRAME
                    rr = byT.get(round(tReal, 3))
                    if not rr:
                        continue
                    pb = [p for p in (rr.get('proj') or []) if p['id'] == bid]
                    if not pb:
                        continue
                    tot += math.hypot(tb[0]['x'] - pb[0]['x'], tb[0]['y'] - pb[0]['y'])
                    cnt += 1
                if cnt >= 3:
                    errs[lag] = tot / cnt
            if errs:
                bl = min(errs, key=errs.get)
                best[bid] = (bl, errs[bl])
        for bid, (lag, err) in best.items():
            print('    弹 %s：最优对齐 = 融合世界落后真实 %d 帧（平均误差 %.2f 米）' % (bid, lag, err))
    return 0


if __name__ == '__main__':
    sys.exit(main())
