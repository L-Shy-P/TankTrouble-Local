# -*- coding: utf-8 -*-
"""用「改前 md5 + 逆向重建」判定每份被改文档【改前】的行尾（LF/CRLF）。
逆向模型：删掉我插入的校正说明行 → 新名→旧名 → 把 n_date 处 '2026-10-12' 还原成 13/14/15。
任一候选命中 → 判定行尾；全部未命中 → None（无改前字节数时不可判定）。"""
import io,os,sys,re,hashlib,itertools
sys.stdout.reconfigure(encoding='utf-8')
OLD='''1-3起点接触-实测与方案-2026-10-13.md|阶段2-1取数清单-2026-10-14.md|阶段2冻结点-选项草案-2026-10-13.md|1-2③-N3墙后反射-2026-10-13.md|1-2③收口-2026-10-13.md|1-2④导弹制导-2026-10-13.md|1-2④收尾-导弹vant2基线-2026-10-14.md|1-2④施工-2026-10-13.md|1-2④施工-第3轮-2026-10-13.md|1-2④施工-第4轮-2026-10-13.md|1-2④施工-第5轮-2026-10-13.md|1-2④施工-第6轮-2026-10-13.md|hidden哨兵分析-2026-10-14.md|hidden哨兵拆分-验收-2026-10-14.md|导航表建表开销-2026-10-14.md|导弹制导实测-2026-10-13.md|证据补课-2026-10-13.md|1-4规格核查与实测-2026-10-13.md|geoHit合并不对称-2026-10-14.md|激光帧号差诊断-2026-10-14.md|签收回执-增量-2026-10-15.md'''.split('|')
NDATE={'1-3起点接触':1,'阶段2-1取数清单':1,'阶段2冻结点':1,'1-2③-N3':1,'1-2③收口':1,'1-2④导弹制导':1,
 '1-2④收尾':2,'1-2④施工-2026':2,'第3轮':1,'第4轮':2,'第5轮':1,'第6轮':1,'hidden哨兵分析':0,
 'hidden哨兵拆分':0,'导航表建表开销':1,'导弹制导实测':1,'证据补课':3,'1-4规格核查':1,'geoHit':1,'激光帧号差':1,'签收回执-增量':2}
NEW={re.sub(r'2026-10-1[3-5]','2026-10-12',o):o for o in OLD}
before={}
for l in io.open('_tools/headless/_dtmp/fingerprint_before.txt',encoding='utf-8'):
    h,m,p=l.rstrip('\n').split('  ',2); before[os.path.basename(p)]=h
def ndate_of(newbase):
    for k,v in NDATE.items():
        if newbase.startswith(k): return v
    return None
def find(b):
    for dp,dn,fn in os.walk('docs/Vantage躲弹实现'):
        if b in fn: return os.path.join(dp,b).replace(os.sep,'/')
def candidates(newbase):
    old=NEW[newbase]; p=find(newbase)
    lines=io.open(p,encoding='utf-8').read().split('\n')
    didx=[i for i,l in enumerate(lines) if l.startswith('> ⚠️ **日期校正')]
    if didx: lines=lines[:didx[0]]+lines[didx[0]+1:]
    inv='\n'.join(lines)
    for nw,ol in NEW.items(): inv=inv.replace(nw,ol)
    pos=[m.start() for m in re.finditer('2026-10-12',inv)]
    n=ndate_of(newbase); out=[]
    if n is None: return old,[]
    if n>len(pos): return old,[]
    for comb in itertools.combinations(pos,n):
        for vals in itertools.product(['2026-10-13','2026-10-14','2026-10-15'],repeat=n):
            seg=[]; last=0
            for pp,vv in zip(comb,vals):
                seg.append(inv[last:pp]); seg.append(vv); last=pp+len('2026-10-12')
            seg.append(inv[last:]); out.append(''.join(seg))
    return old,out
if __name__=='__main__':
    nfile=0; res={}
    for dp,dn,fn in os.walk('docs/Vantage躲弹实现'):
        for f in sorted(fn):
            if not re.search(r'2026-10-12',f) or not f.endswith('.md'): continue
            if f in ('交付-给架构方针AI-2026-10-12.md','交付回应-2026-10-12.md','签收回执-2026-10-12.md'): continue
            nfile+=1
            old,cands=candidates(f)
            hit=None; nc=len(cands)
            for c in cands:
                for eol,tag in (('\n','LF'),('\r\n','CRLF')):
                    if hashlib.md5(c.replace('\n',eol).encode('utf-8')).hexdigest()==before.get(old):
                        hit=tag; break
                if hit: break
            res[f]=hit
            print('%-52s 改前md5=%s 候选=%4d 改前行尾=%s'%(f,before.get(old,'?')[:8],nc,hit))
    print()
    from collections import Counter
    print('汇总:',Counter(res.values()))
