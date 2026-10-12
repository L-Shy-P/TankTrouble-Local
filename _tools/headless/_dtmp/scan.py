import os,re,sys
SEP=os.sep
skipdirs=('_libs','dist','_backup','.git','node_modules','__pycache__','_ev_pg','tools/flywire','tools\flywire')
exts=('.md','.js','.rs','.py','.html','.json','.log','.txt','.sh','.bat','.css','.toml','.jsonl','.csv')
targets=[]
for dp,dn,fn in os.walk('docs/Vantage躲弹实现'):
    for f in fn:
        if re.search(r'2026-10-1[3-9]',f):
            targets.append((dp.replace(SEP,'/'),f))
targets.sort(key=lambda t:(t[0],t[1]))
print("=== 目标文件清单 (%d) ==="%len(targets))
for d,f in targets: print("   %s/%s"%(d,f))
# step2: references
hits={}
for dp,dn,fn in os.walk('.'):
    d=dp.replace(SEP,'/')
    if any(s in d for s in skipdirs): continue
    for f in fn:
        if not f.lower().endswith(exts): continue
        p=(d+'/'+f) if d!='.' else f
        try: txt=open(p,encoding='utf-8',errors='replace').read()
        except Exception: continue
        lines=txt.split('\n')
        for sub,f2 in targets:
            for i,l in enumerate(lines,1):
                if f2 in l:
                    hits.setdefault(f2,[]).append((p,i,l.strip()[:160]))
print()
print("=== 完整文件名引用（全仓，排除 _libs/dist/_backup/_ev_pg/_tmp）===")
for _,f2 in targets:
    hs=hits.get(f2,[])
    print("\n## %s   (%d 处)"%(f2,len(hs)))
    for p,i,l in hs: print("   %s:%d  %s"%(p,i,l))
