# -*- coding: utf-8 -*-
"""只读：从实战录像 vantage_record_*.json 复算
   ① Δ = t - anchor.abs0 的分布（按弹种）  ② 重锚(sawtooth)事件  ③ commit 间隔(=shift)
   ④ E8 近似（威胁表里有弹、实时 projectile 取不到）
不改 game_core。用法: python _tools/headless/_probe_anchor_delta_records.py
"""
import json, os, math, glob, re
from collections import defaultdict, Counter

DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'game_core', '测试反馈')
FAM = {'b': '子弹BULLET', 'db': '双管DOUBLE_BARREL', 'sg': '霰弹SHOTGUN', 'gg': '加特林GATLING',
       'hm': '追踪导弹HOMING', 'l': '激光LASER', 'mb': '破片MINE_SHRAPNEL'}

def pctl(xs, p):
    if not xs: return float('nan')
    a = sorted(xs); return a[min(len(a)-1, max(0, int(math.floor(p*len(a)))))]

def fam(pid):
    p = str(pid).split('-')[0]
    return FAM.get(p, '其它(%s)' % p)

def load(fp):
    with open(fp, 'r', encoding='utf-8') as f: return json.load(f)

def line(xs, tag):
    xs = sorted(xs)
    if not xs: print('  %-30s n=0' % tag); return
    print('  %-30s n=%-5d min=%7.3f med=%7.3f p90=%7.3f p99=%7.3f max=%7.3f' % (
        tag, len(xs), xs[0], pctl(xs,.5), pctl(xs,.9), pctl(xs,.99), xs[-1]))

def main():
    files = sorted(glob.glob(os.path.join(DIR, 'vantage_record_*.json')))
    print('== A. 录像清单 ==')
    usable = []
    for fp in files:
        try: d = load(fp)
        except Exception as e: print('  %-40s LOAD_ERR %s' % (os.path.basename(fp), e)); continue
        recs = d.get('records') or []
        has_abs0 = any((r.get('anchors') or []) and any(a.get('abs0') is not None for a in r['anchors']) for r in recs)
        has_proj = any(isinstance(r.get('proj'), list) and r['proj'] and isinstance(r['proj'][0], dict) for r in recs)
        print('  %-40s tree=%-6s frames=%-4s abs0=%-5s proj明细=%-5s start=%s' % (
            os.path.basename(fp), (d.get('meta') or {}).get('treeVersion'), d.get('frames'), has_abs0, has_proj, d.get('startReason')))
        usable.append((fp, d, has_abs0, has_proj))

    print()
    print('== B. Δ 分布（= t - anchor.abs0；仅带 anchorProbe 的录像） ==')
    for fp, d, has_abs0, _ in usable:
        if not has_abs0: continue
        base = os.path.basename(fp); recs = d['records']; meta = d['meta']
        fdt = meta.get('frameDt') or 0.02
        rows = []
        for r in recs:
            t = r.get('t')
            for a in (r.get('anchors') or []):
                if a.get('abs0') is None or t is None: continue
                rows.append((t, a['id'], t - a['abs0'], a.get('len'), a.get('v0'), a.get('vr'), a.get('drift')))
        print('-- %s tree=%s frameDt=%.5f 样本帧=%d Δ样本=%d 唯一威胁=%d --' % (base, meta.get('treeVersion'), fdt, len(recs), len(rows), len(set(x[1] for x in rows))))
        line([x[2] for x in rows], 'Δ 全样本')
        byfam = defaultdict(list)
        for x in rows: byfam[fam(x[1])].append(x[2])
        for k in sorted(byfam, key=lambda k: -max(byfam[k])):
            line(byfam[k], '  [%s]' % k)
        print('    弹种样本量: %s' % {k: len(v) for k, v in byfam.items()})
        # 逐威胁：Δ 时间序列 → 重锚次数 / 最大年龄
        byid = defaultdict(list)
        for x in rows: byid[x[1]].append(x)
        print('    逐威胁（Δmax=锚点最大年龄；重锚=Δ 回落到 <25% 峰值 的次数；cap=len*frameDt）:')
        for pid, rs in sorted(byid.items(), key=lambda kv: -max(x[2] for x in kv[1])):
            rs = sorted(rs, key=lambda x: x[0]); ds = [x[2] for x in rs]; mx = max(ds)
            drops = sum(1 for i in range(1, len(rs)) if ds[i] < 0.25*mx and ds[i] < ds[i-1])
            age = rs[-1][0] - rs[0][0]; cap = (rs[-1][3] or 0)*fdt
            print('      %-14s Δmax=%.3f Δmed=%.3f 观测年龄=%.2fs track.len=%s cap=%.2fs Δmax/cap=%.2f 重锚=%d 采样=%d' % (
                pid, mx, pctl(ds,.5), age, rs[-1][3], cap, (mx/cap if cap else float('nan')), drops, len(rs)))
        # Δ 与 t 的斜率（确认锚点年龄以 1.0 速度增长）
        ups = []
        for pid, rs in byid.items():
            rs = sorted(rs, key=lambda x: x[0])
            for i in range(1, len(rs)):
                dt = rs[i][0] - rs[i-1][0]
                if dt > 1e-9 and rs[i][2] > rs[i-1][2]: ups.append((rs[i][2]-rs[i-1][2])/dt)
        line(ups, '    上升沿 dΔ/dt（应≈1）')
    print()
    print('== C. commit 间隔 = shift（reanchor 复用的门限是 shift<=1.0s）==')
    for fp, d, _, _ in usable:
        recs = d['records']
        cids = [(r.get('t'), r.get('commitId')) for r in recs if r.get('commitId') is not None]
        gaps = []; last = None
        for t, c in cids:
            if last is not None and c != last[1] and t > last[0]: gaps.append(t - last[0])
            last = (t, c)
        if gaps:
            line(gaps, '  %-30s' % os.path.basename(fp)[:30])
    print()
    print('== D. E8 近似（威胁表里有弹、实时 projectile 取不到）==')
    for fp, d, _, has_proj in usable:
        base = os.path.basename(fp); recs = d['records']
        if has_proj:
            n = 0; tot = 0; ex = []
            for r in recs:
                tids = [s for s in re.split(r'[,\s]+', (r.get('threatIds') or '')) if s]
                pj = set(p['id'] for p in (r.get('proj') or []) if p and p.get('id'))
                tot += len(tids)
                miss = [x for x in tids if x not in pj]
                if miss:
                    n += len(miss); ex.append((r.get('t'), miss))
            print('  %-38s [proj明细] 缺失威胁帧发生=%d 次 / 威胁-帧 %d (%.2f%%) 例=%s' % (base, n, tot, 100.0*n/max(1,tot), json.dumps(ex[:3], ensure_ascii=False)))
        else:
            n = 0; tot = 0; fr = 0; ex = []
            for r in recs:
                ths = r.get('threats') or 0; anc = len(r.get('anchors') or [])
                tot += ths
                if ths > anc: n += ths - anc; fr += 1; ex.append((r.get('t'), ths, anc))
            print('  %-38s [anchors口径] 威胁-帧 %d；其中无实时弹(anchors缺)=%d 次 (%.2f%%)，涉及 %d 帧 例=%s' % (
                base, tot, n, 100.0*n/max(1,tot), fr, json.dumps(ex[:3], ensure_ascii=False)))
    print()
    print('== E. 各录像里出现过的弹种（proj/threatIds/deaths 前缀）==')
    for fp, d, _, _ in usable:
        recs = d['records']; c = Counter()
        for r in recs:
            for p in (r.get('proj') or []):
                if isinstance(p, dict) and p.get('id'): c[fam(p['id'])] += 1
            for s in re.split(r'[,\s]+', (r.get('threatIds') or '')):
                if s: c[fam(s)] += 0
        for x in (d.get('deaths') or []): c['死亡:'+fam(x.get('projectileId','?'))] += 1
        print('  %-38s %s' % (os.path.basename(fp), dict(c)))
    print()
    print('口径：Δ = 记录帧 t − anchor.abs0；abs0 = rootAbsT + anchorOffset（anchorProbe，逐帧）')

main()
