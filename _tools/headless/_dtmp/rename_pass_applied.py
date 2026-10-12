import os,re,sys,io,hashlib,json
sys.stdout.reconfigure(encoding='utf-8')
APPLY = ('--apply' in sys.argv)
ROOT=os.getcwd()

# ---------- 1. 目标清单：docs 下文件名带 2026-10-1[3-9] ----------
def newname(fn):
    return re.sub(r'2026-10-1[3-9]', '2026-10-12', fn)

TARGETS=[]
for dp,dn,fn in os.walk('docs/Vantage躲弹实现'):
    for f in fn:
        if re.search(r'2026-10-1[3-9]', f):
            TARGETS.append((os.path.join(dp,f).replace(os.sep,'/'), os.path.join(dp,newname(f)).replace(os.sep,'/'), f, newname(f)))
TARGETS.sort()
old2new = {t[2]: t[3] for t in TARGETS}

# ---------- 2. 其余需要改引用的文件 ----------
OTHER = [
 'AGENTS.md',
 'docs/Vantage躲弹实现/01-设计理论/权威与定案/智能体架构-权威版-2026-10-07.md',
 'docs/Vantage躲弹实现/03-踩坑与待查/实测数据/JS-Rust判死频率-2026-10-11.md',
 'docs/Vantage躲弹实现/交付-给架构方针AI-2026-10-12.md',
 'docs/Vantage躲弹实现/交付回应-2026-10-12.md',
 'docs/Vantage躲弹实现/签收回执-2026-10-12.md',
 'game_core/js/vantage_tree.js',
 '_tools/headless/_baseline_multiai_vant2.js',
 '_tools/headless/_baseline_multiai_vant2_missile.js',
]

def fingerprint(paths):
    out=[]
    for p in paths:
        if not os.path.exists(p): out.append((p,'MISSING',None)); continue
        st=os.stat(p); h=hashlib.md5(open(p,'rb').read()).hexdigest()
        out.append((p,h,__import__('datetime').datetime.fromtimestamp(st.st_mtime).strftime('%Y-%m-%d %H:%M:%S')))
    return out

target_paths=[t[0] for t in TARGETS]
before = fingerprint(target_paths+OTHER)

# 排除行：正文里的《…实测更正》标记引文（与 AGENTS.md/权威版 的标记保持一致，不在本轮改）
EXCL = re.compile(r'原文保留作对照|实测更正')
DATES = [('2026-10-15','2026-10-12'),('2026-10-14','2026-10-12'),('2026-10-13','2026-10-12')]

def edit_text(txt, do_dates, is_target):
    n_name=0; n_date=0; excl=[]
    for old,new in old2new.items():
        if old in txt:
            n_name += txt.count(old); txt = txt.replace(old,new)
    if do_dates:
        lines=txt.split('\n')
        for i,l in enumerate(lines):
            if EXCL.search(l):
                if re.search(r'2026-10-1[3-5]', l): excl.append((i+1,l.strip()[:120]))
                continue
            for o,n in DATES:
                if o in l:
                    n_date += l.count(o); l = l.replace(o,n)
            lines[i]=l
        txt='\n'.join(lines)
    return txt, n_name, n_date, excl

NOTE = ("> ⚠️ **日期校正（2026-10-12，主人指示）**：本文件原名 `{old}`（内嵌未来日期），"
        "实际日期为 **2026-10-12**；本条记的是旧名，便于按旧名检索到本文。{extra}\n")

plan=[]
for old_path,new_path,old_base,new_base in TARGETS:
    txt=io.open(old_path,encoding='utf-8').read()
    new_txt,n_name,n_date,excl = edit_text(txt, True, True)
    extra = ''
    if old_base == '1-2④施工-第3轮-2026-10-13.md':
        extra = '（⚠️ 旧名仍被 `game_core/rust/vantage_core/src/vtmaze.rs:3` 的注释引用，本轮按"别碰 game_core"边界未改。）'
    note = NOTE.format(old=old_base, extra=extra)
    lines=new_txt.split('\n')
    if lines and lines[0].startswith('#'):
        lines.insert(1, note.rstrip('\n'))
    else:
        lines.insert(0, note.rstrip('\n'))
    new_txt='\n'.join(lines)
    plan.append(('rename+edit', old_path, new_path, n_name, n_date, excl))

for p in OTHER:
    txt=io.open(p,encoding='utf-8').read()
    new_txt,n_name,n_date,excl = edit_text(txt, False, False)
    if n_name: plan.append(('edit-refs', p, p, n_name, 0, []))

print('=== 计划 ===')
for kind,a,b,n_name,n_date,excl in plan:
    print(f'[{kind}] {a}  ->  {b}   (文件名引用替换 {n_name} 处, 日期替换 {n_date} 处)')
    for ln,l in excl: print(f'         排除(引文标记) {os.path.basename(a)}:{ln}  {l[:80]}')

print()
print('=== 改名后仍会残留旧名的位置预检 ===')
leftover=[]
for old,new in old2new.items():
    for dp,dn,fn in os.walk('.'):
        d=dp.replace(os.sep,'/')
        if any(s in d for s in ('/_libs','/dist','/_backup','/.git','/node_modules','/_ev_pg','/tools/flywire','/_dtmp')): continue
        for f in fn:
            if not f.lower().endswith(('.md','.js','.rs','.py','.html','.json','.log','.txt','.sh','.bat')): continue
            pp=(d+'/'+f) if d!='.' else f
            try: t=io.open(pp,encoding='utf-8',errors='replace').read()
            except Exception: continue
            c=t.count(old)
            if c and pp not in set([x[0] for x in TARGETS]) and pp not in OTHER and not pp.startswith('./docs'):
                leftover.append((old,pp,c))
            elif c and pp not in set([x[0] for x in TARGETS]) and pp not in OTHER:
                leftover.append((old,pp,c))
print(json.dumps(sorted(set(leftover)), ensure_ascii=False, indent=1))

if APPLY:
    print('\n=== 应用 ===')
    for kind,a,b,_,_,_ in plan:
        if kind=='rename+edit':
            txt=io.open(a,encoding='utf-8').read()
            new_txt,_,_,_ = edit_text(txt, True, True)
            extra = '（⚠️ 旧名仍被 `game_core/rust/vantage_core/src/vtmaze.rs:3` 的注释引用，本轮按"别碰 game_core"边界未改。）' if a.endswith('1-2④施工-第3轮-2026-10-13.md') else ''
            note = NOTE.format(old=os.path.basename(a), extra=extra)
            lines=new_txt.split('\n'); lines.insert(1 if lines and lines[0].startswith('#') else 0, note.rstrip('\n'))
            io.open(b,'w',encoding='utf-8',newline='\n').write('\n'.join(lines))
            os.remove(a)
            print('RENAMED', a, '->', b)
        else:
            txt=io.open(a,encoding='utf-8').read()
            new_txt,_,_,_ = edit_text(txt, False, False)
            io.open(a,'w',encoding='utf-8',newline='\n').write(new_txt)
            print('EDITED ', a)
    io.open('_tools/headless/_dtmp/fingerprint_before.txt','w',encoding='utf-8').write('\n'.join(f'{h}  {m}  {p}' for p,h,m in before))
    print('BEFORE 指纹已存 _tools/headless/_dtmp/fingerprint_before.txt')
