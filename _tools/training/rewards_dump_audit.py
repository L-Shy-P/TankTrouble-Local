# -*- coding: utf-8 -*-
"""把 `S30_DUMP=1` 产出的 `episodes.jsonl` 逐帧过一遍 `rewards.explain()`，逐项报【非零帧数 / 合计值】。

用法：
    PYTHONIOENCODING=utf-8 py -3.13 _tools/training/rewards_dump_audit.py D:/vt_run/subfix/ep/episodes.jsonl

口径（⛔ 不许糊）：
  · `非零帧数` = `parts[k][2]`（**贡献值**，= 原始量 × 权重）绝对值 > 1e-12 的帧数
  · `合计值`  = 该贡献值逐帧求和
  · 同时打印"原始量非零帧数"（`parts[k][0]`），用来区分
        「**权重把值压成 0**」 和 「**原始量本来就是 0 / 压根没采到**」——这两件事后果完全不同。
  · `R.STATS` 里的计数器原样打印（每个 0 的**原因**都在里面：t_min 缺失 / 无对手 / 单位判不出 …）
"""
import collections
import io
import json
import sys

sys.path.insert(0, '_tools/training')
import rewards as R   # noqa: E402


def _val(part):
    if isinstance(part, (tuple, list)) and len(part) >= 3:
        return float(part[0]), float(part[1]), float(part[2])
    return None, None, float(part)


def main(path):
    rows = [json.loads(l) for l in io.open(path, encoding='utf-8') if l.strip()]
    cnt = collections.Counter()      # 贡献 != 0 的帧数
    mag = collections.Counter()      # 贡献合计
    raw_nz = collections.Counter()   # 原始量 != 0 的帧数
    raw_sum = collections.Counter()  # 原始量合计
    w_seen = {}
    n = 0
    extra = collections.Counter()
    tmin_vals = []
    aimdegs = []
    ammo_vals = collections.Counter()
    item_nz_frames = 0
    for ep_i, ep in enumerate(rows):
        for fr in ep['frames']:
            n += 1
            parts, total = R.explain(fr, {})
            for k, v in parts.items():
                raw, w, contrib = _val(v)
                w_seen[k] = w
                if abs(contrib) > 1e-12:
                    cnt[k] += 1
                    mag[k] += contrib
                if raw is not None:
                    if abs(raw) > 1e-12:
                        raw_nz[k] += 1
                        raw_sum[k] += raw
            r = fr.get('r') or {}
            dbg = fr.get('dbg') or {}
            # ── 数据可用性证据（"检测器瞎了" vs "真的没有"）──
            if r.get('t_min') is not None:
                tmin_vals.append(r['t_min'])
            if isinstance(dbg.get('aimDeg'), (int, float)):
                aimdegs.append(float(dbg['aimDeg']))
            g = (fr.get('obs') or {}).get('global')
            if g:
                row = g[0] if isinstance(g[0], (list, tuple)) else g
                try:
                    ammo_vals[('ammoLeft=global[15]', row[15])] += 1
                except Exception:
                    extra['ammo_read_err'] += 1
            it = (fr.get('obs') or {}).get('item') or []
            got = 0
            for rr in it:
                for x in (rr[:3] if len(rr) >= 3 else rr):
                    if x:
                        got += 1
            if got:
                item_nz_frames += 1
            # ── 一致性：结果行 still_frames  vs  逐帧 r.still  vs  execStill ──
            if r.get('still') == 1:
                extra['r_still_1'] += 1
            if fr.get('execStill') is True:
                extra['execStill_true'] += 1
            if r.get('empty_fire') == 1:
                extra['r_empty_1'] += 1
            if 'crate' in r:
                extra['r_has_crate_key'] += 1
            if 'hit' in r:
                extra['r_has_hit_key'] += 1
            if 't_min' in r:
                extra['r_has_tmin_key'] += 1
                if r.get('t_min') is None:
                    extra['r_tmin_null'] += 1
            if 'still' in r:
                extra['r_has_still_key'] += 1
            if r.get('hit_term_derived'):
                extra['hit_term_derived'] += 1
            if r.get('draw'):
                extra['draw_frames'] += 1
            if r.get('selfkill'):
                extra['selfkill_frames'] += 1
    print('总帧', n, ' 局数', len(rows))
    print('%-16s %10s %14s %10s %14s %8s' % ('奖惩项', '非零帧数', '合计贡献', '原始量非零帧', '原始量合计', '权重'))
    for k in R.ITEMS:
        print('%-16s %10d %14.4f %10d %14.4f %8s'
              % (k, cnt.get(k, 0), mag.get(k, 0.0), raw_nz.get(k, 0), raw_sum.get(k, 0.0), w_seen.get(k)))
    print('总奖励合计 = %.6f' % sum(mag.values()))
    print()
    print('--- 数据可用性（把"没采到"和"真的是 0"分开）---')
    print('r 里带这些键的帧数：', {k: v for k, v in sorted(extra.items())})
    print('t_min 非空的帧数 = %d / %d' % (len(tmin_vals), n),
          ('  取值集合=%s' % sorted(set(tmin_vals))[:12]) if tmin_vals else '')
    if aimdegs:
        a = sorted(aimdegs)
        q = lambda p: round(a[int(p * (len(a) - 1))], 1)
        print('aimDeg 样本=%d  p05=%s p25=%s p50=%s p75=%s p95=%s  |deg|<=20 的帧=%d'
              % (len(a), q(0.05), q(0.25), q(0.5), q(0.75), q(0.95),
                 sum(1 for x in a if abs(x) <= 20)))
    print('item 段有非零的帧数 =', item_nz_frames)
    print('ammoLeft 取值分布 =', dict(ammo_vals.most_common(8)))
    print()
    print('--- rewards.STATS（每个 0 的原因）---')
    for k, v in sorted(R.STATS.items()):
        if v:
            print('  %-34s %s' % (k, v))


if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv) > 1 else 'D:/vt_run/subfix/ep/episodes.jsonl')
