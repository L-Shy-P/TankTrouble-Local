# -*- coding: utf-8 -*-
"""异步 rollout 策略端【v2：四档 CUDA Graphs 版】—— 与原版并存、可用 USE_GRAPH=0 退回原路
档表 (64/256/512/1000)：查表 = "第一个 >= 真实 N 的档"（含 1000 必须，真 N 的 p75=1000）
"""
import os, sys, json, math, torch, hashlib, importlib.util, io, contextlib
spec=importlib.util.spec_from_file_location("nv2","_tools/training/net_v2_fixed.py"); nv2=importlib.util.module_from_spec(spec)
with contextlib.redirect_stdout(io.StringIO()): spec.loader.exec_module(nv2)
PAYLOAD_KIND=None
USE_GRAPH = os.environ.get('USE_GRAPH','1') == '1'
dev="cuda" if torch.cuda.is_available() else "cpu"
print("DEV",dev,"USE_GRAPH",USE_GRAPH,flush=True)          # ⚠️ 打印当前模式（合法但不同的默认值要打印）
NET_SPLIT = os.environ.get('VT_NET_SPLIT','0') == '1'
model=nv2.NetV2().to(dev).eval()                                    # B 网（选路/开火/价值）
model_a=nv2.NetV2Small(d=128, layers=4).to(dev).eval() if NET_SPLIT else None   # ⭐ A 网 d=128,L=4（与训练器同尺寸）            # ⭐ A 网（只出 grow）：同一个类、同形状
print("NET_SPLIT", NET_SPLIT, flush=True)   # ⭐ 合法但不同的模式必须打印
# ⭐ 权重加载（搭车项，2026-10-17 父代理裁定）：VT_CKPT 指向的 ckpt 存在才加载；诊断一律走 stderr（⛔ 不破一问一答协议）
_CKPT=os.environ.get('VT_CKPT','')
if _CKPT and os.path.isfile(_CKPT):
    _ck=torch.load(_CKPT,map_location=dev,weights_only=True)      # 自己的 ckpt；weights_only=True 更安全
    if not (isinstance(_ck,dict) and 'model' in _ck):
        raise ValueError("ckpt 缺 'model' 键（实际键名 %s）—— ⛔ 不猜" % (sorted(_ck.keys()) if isinstance(_ck,dict) else type(_ck).__name__))
    _ck_a = _ck.get('model_a'); _ck_b = _ck.get('model_b', _ck.get('model'))
    if NET_SPLIT and _ck_a is not None:
        _ra = model_a.load_state_dict(_ck_a, strict=False); _rb = model.load_state_dict(_ck_b, strict=False)
        print("CKPT_SPLIT A_missing=%s B_missing=%s A_unexpected=%s B_unexpected=%s" % (list(_ra.missing_keys), list(_rb.missing_keys), list(_ra.unexpected_keys), list(_rb.unexpected_keys)), file=sys.stderr, flush=True)
        _r = _rb
    else:
        if NET_SPLIT: print("CKPT_SINGLE_BOTH 双网模式但 ckpt 只有单份 ⇒ A/B 两边都载同一份", file=sys.stderr, flush=True)
        _r = model.load_state_dict(_ck["model"], strict=False)
        if NET_SPLIT: model_a.load_state_dict(_ck["model"], strict=False)   # ⭐ 记忆头是新增的 ⇒ strict=False（老权重一位不动）
    print("CKPT_KEYS missing=%s unexpected=%s" % (list(_r.missing_keys), list(_r.unexpected_keys)), file=sys.stderr, flush=True)   # ⏔t 不静默：逐条打印
    if list(_r.unexpected_keys): raise ValueError("多余键 %s ⇒ ckpt 与网络不匹配（⏔t 静默丢弃）" % list(_r.unexpected_keys))               # ⭐ 原地 copy_（不换 Parameter）：录图前加载，图指针不受影响
    print("CKPT_LOADED %s md5=%s step=%s" % (_CKPT,hashlib.md5(open(_CKPT,'rb').read()).hexdigest()[:8],_ck.get('step')),file=sys.stderr,flush=True)
elif _CKPT:
    print("CKPT_MISSING %s -> 保持随机初始化（⛔ 非静默；要加载请检查路径）" % _CKPT,file=sys.stderr,flush=True)
else:
    print("CKPT_NONE（未设 VT_CKPT ⟹ 随机初始化权重）",file=sys.stderr,flush=True)
_MEM = {'A': None, 'B': None}   # ⭐ 记忆槽 v1：A/B 各 2×256（合计 4×256 = 现有 mem 槽）
_MEM_ROUND = None               # ⭐ 回合 id：变化 ⇒ 两份都清零（⏔t 跳局残留）
TIERS=(64,256,512,1008)   # ⭐ 主人裁定(2026-10-16)：最高档 1008（1000 停止生长、但 999 节点时生长 +9 ⟹ 理论最大 1008）
B=1
_MK = {}                                                   # ⭐ 首请求分段计时容器（插桩用、稳态不受影响）
_REQN = 0                                                  # ⭐ 请求计数：载荷没给 seed 时配合时间戳生成"换着来"的采样种子（⛔ 不再固定 12345）
_F1 = 0; _F0 = 0; _FIRE_PRINTED = False; _FIRE_DIST_AT = 200   # ⭐ 开火头取值分布的核对计数（stderr 打一次；⛔ 不进 stdout 协议）
_TRACE = False                                             # ⭐ 插桩总开关（默认关：插桩不得破坏"一问一答"协议）
_FIRST_PRINT = True                                        # ⭐ FIRST_SEGS 只打一次
# ⭐ 2026-10-18（性能代理）：**分段耗时探针**（默认关 ⟹ 回包协议/耗时口径一字不变）
#   VT_PROBE_MS=1 ⟹ 回包多一个 `_pm` 字段（服务端内部各段 ms + 总 ms），用于「服务端内部 vs transport」拆分
_PROBE_MS = os.environ.get('VT_PROBE_MS', '0') == '1'
# ⭐ 2026-10-18（性能代理）：**逐项可开关的优化**（默认全关 ⟹ 老口径一字不变；`VT_FAST=mem,echo,json,tensor,argmax,sync`）
#   mem    : mem_on=0 时不再往 segs 里塞 4×256 零行（图槽本来就已清零 ⟹ 语义相同）
#   echo   : mem_on=0 时不再回 1024 个 mem_echo 数字（默认保留，兼容 _collect_tmp.js 的对拍字段）
#   json   : 用 orjson 解析请求（数值逐位相同：两者都是 IEEE754 往返）
#   tensor : 段→张量走 numpy（float32 舍入规则与 torch.tensor 相同）
#   argmax : 删掉【只给 _TRACE 打印用】的 argmax（它的结果不参与任何输出）
#   sync   : 把 4 处 GPU→CPU 标量读取合并成 1 次同步（数值逐位相同）
_FAST = set(x.strip() for x in (os.environ.get('VT_FAST', '') or '').split(',') if x.strip())
if _FAST:
    print('FAST_ON ' + ','.join(sorted(_FAST)), flush=True)
import numpy as _np
try:
    import orjson as _orjson
except Exception:
    _orjson = None
_PM = {}                                                   # 最近一次请求的分段耗时（ms）
_WROTE_PREV = set()                                        # ⭐ 'zero' 优化用：上一次请求真正写过的段名
N_OPP = nv2.N_OPP                                          # ⭐ opp 槽行数【唯一来源】= net_v2_fixed.py:8（⛔ 不在这里另写一个数）
CTX = N_OPP + nv2.N_BUL + nv2.N_ITM + nv2.N_GLB + nv2.N_MEM + nv2.N_PLAN   # ⭐ +plan1（事实直传）   # 上下文 token 数：opp1 时=78，opp8 时=85
assert CTX == 86, "CTX_TOKENS=%d≠86 ⟹ 与 vt_buffer.py 的 CTX_TOKENS 漂了，别放行" % CTX
print("CTX_TOKENS", CTX, "N_OPP", N_OPP, "POS_NORM", getattr(nv2, 'POS_NORM', '?'), flush=True)   # ⚠️ 常量必须开机打印（铁律二）；POS_NORM 来源 = net_v2_fixed.py:9（⛔ 不在这里另写）
def mk(N):                                                # ⭐ 裁剪唯一入口（张量与掩码同长）
    segs={'node':torch.zeros(B,N,10,device=dev),'opp':torch.zeros(B,N_OPP,15,device=dev),'bullet':torch.zeros(B,64,7,device=dev),
          'item':torch.zeros(B,8,6,device=dev),'global':torch.zeros(B,1,38,device=dev),'mem':torch.zeros(B,4,256,device=dev),'plan':torch.zeros(B,1,nv2.SEG['plan'],device=dev)}   # ⭐ plan 槽
    mask=torch.zeros(B,N+CTX,dtype=torch.bool,device=dev)
    assert mask.shape[1]==sum(v.shape[1] for v in segs.values()), '掩码与张量长度不一致（CTX=%d）' % CTX
    return segs,mask
_graphs={}
def pick_tier(N):
    for t in TIERS:
        if N<=t: return t
    return TIERS[-1]
def get_graph(N):                                         # ⭐ 懒加载录图（第一次遇到该档才录）
    t=pick_tier(N)
    if t not in _graphs:
        static,mask=mk(t)
        for _ in range(3): model(static,mask)
        torch.cuda.synchronize()
        g=torch.cuda.CUDAGraph()
        with torch.cuda.graph(g): out=model(static,mask)
        g.replay(); torch.cuda.synchronize()
        _graphs[t]=(g,static,mask,out)
    return _graphs[t]
_mgraphs={}
def get_mem_graph(N):
    """⭐ 'memg'：记忆写头 `model.write_mem` 的 CUDA Graph（同一份 static/mask 图槽）。
    动机（2026-10-18 实测）：mem_on=1 时它每帧**再跑一遍整条 trunk**（未录图）⟹ 面板路径每帧多 5~7ms，
    直接把 60fps 打到 46fps。录图后与主前向同量级。⛔ 数值不变（同一份权重/同一份 static/mask）。
    """
    t=pick_tier(N)
    if t not in _mgraphs:
        g,static,mask,_out=get_graph(N)
        try:
            for _ in range(3): model.write_mem(static,mask)
            torch.cuda.synchronize()
            mg=torch.cuda.CUDAGraph()
            with torch.cuda.graph(mg): mo=model.write_mem(static,mask)
            mg.replay(); torch.cuda.synchronize()
            _mgraphs[t]=(mg,mo)
            print("MEMGRAPH_OK tier=%d out=%s" % (t,tuple(mo.shape)), file=sys.stderr, flush=True)
        except Exception as e:
            _mgraphs[t]=None
            print("MEMGRAPH_FAIL tier=%d %r ⟹ 退回直接调用（⛔ 非静默）" % (t,e), file=sys.stderr, flush=True)
    return _mgraphs.get(t)
def real_n(obs):
    """⭐ 真实节点数 N_real 的【唯一入口】（载荷归一 + 显式取 N；⛔ 不静默降级）
    依据：`segs.node` 的【行数】= 实际会 copy 进图槽的节点行数（比 N 字段更直接、是候选集的上界）；
          `N` 字段是生产端声明的真实节点数。两者不一致 ⟹ 生产端有 bug，显式报错（⛔ 不猜、不取小）。
    ⛔ 缺 `segs.node` / 缺 `N` / N>最高档 一律抛错 —— 绝不用档位大小顶替（上一版 `min(1008,...)` 是静默截断）。
    """
    global PAYLOAD_KIND
    if 'segs' not in obs and ('g' in obs or 'n' in obs):
        nseg=obs.get('n') or []
        if not nseg: raise ValueError("载荷没有 n（节点行）—— ⛔ 拒绝用默认 1000 顶替")
        obs['segs']={'node':nseg,'global':[obs.get('g') or [0.0]*38]}
        obs['N']=len(nseg)                       # ⭐ g/n 分支：客户端发来几行，真实节点就只有几行
        PAYLOAD_KIND='g/n'
    else:
        PAYLOAD_KIND='segs'
    if 'segs' not in obs or 'node' not in obs['segs']:
        raise ValueError("载荷缺少 segs.node —— ⛔ 拒绝用档位大小顶替真实节点数")
    n_rows=len(obs['segs']['node'])
    if 'N' not in obs:
        raise ValueError("载荷缺少 N（真实节点数）—— ⛔ 拒绝默认最高档")
    if int(obs['N'])!=n_rows:
        raise ValueError("N=%s 与 segs.node 行数 %d 不一致 —— ⛔ 拒绝猜哪个是真的" % (obs['N'],n_rows))
    if n_rows<1: raise ValueError("真实节点数=%d" % n_rows)
    if n_rows>TIERS[-1]:
        raise ValueError("真实节点数 %d > 最高档 %d —— ⛔ 不静默截断，请加档或裁剪观测" % (n_rows,TIERS[-1]))
    return obs,n_rows,pick_tier(n_rows)
def forward(obs):
    global _MK, _FIRST_PRINT                                    # PAYLOAD_KIND 由 real_n() 设置；_MK/_FIRST_PRINT = 首请求分段计时
    obs,N,t=real_n(obs)                                         # ⭐ 真实 N/档位（唯一入口；缺字段/不一致/超档都显式报错）
    if USE_GRAPH:
        g,static,mask,out=get_graph(N)
        mask.zero_()                                             # ⭐ 掩码语义（出处 net_v2_fixed.py:26 的 src_key_padding_mask 与 :30 的 masked_fill）：True=填充/无效
        mask[0,N:mask.shape[1]-CTX]=True                          # ⭐ 只标【节点区】[N_real,tier) 填充位；opp/bullet/item/global/mem 这 CTX 个上下文 token 永远是信息、不屏蔽
        _t8=__import__('time').time()
        if 'zero' in _FAST:
            # ⭐ 只清零【本请求载荷没覆盖到】的格子（'zero'）：被整段覆盖的行不清 ⟹ 少 6~7 次 kernel launch + 40KB 写
            #   语义与"全清再写"逐位相同：没被写的格子必须为 0（= 上一帧残留必须清掉），被写的格子本来就被覆盖。
            _cov = set(obs['segs'].keys())
            for _k in _WROTE_PREV - _cov: static[_k].zero_()       # 上一帧写过、这一帧不给的段 ⟹ 必须清（否则残留）
            for _k,v in obs['segs'].items():
                _r = len(v)
                if _r < static[_k].shape[1]: static[_k][0,_r:,:].zero_()   # 行没填满的尾段
            _WROTE_PREV.clear(); _WROTE_PREV.update(_cov)
        else:
            for _k in static: static[_k].zero_()                  # ⭐ 各段每次请求先清零：载荷给几行就写几行、其余补零
        #    （图槽复用 ⟹ 不清零会残留上一请求的 opp/bullet/item 行；训练侧是补零 ⟹ 不清零就变"两套输入分布"）
        _tt=0.0; _tc2=0.0
        for k,v in obs['segs'].items():                   # ⭐ 原地 copy_（别新建张量）
            _t7=__import__('time').time()
            if 'tensor' in _FAST:
                try: src=torch.from_numpy(_np.asarray(v,dtype=_np.float32))   # ⭐ 快路：C 层一次性转（float32 舍入同 torch.tensor）
                except Exception: src=torch.tensor(v,device=dev)             # ⭐ 保持原报错路径（畸形载荷仍走原异常）
            else:
                src=torch.tensor(v,device=dev)   # ⭐ 图路（计时点）
            _tt+=__import__('time').time()-_t7
            if src.dim()!=2: raise ValueError("段 %s 必须是二维 (行,宽)，实际 %s" % (k,tuple(src.shape)))
            if src.shape[0]>static[k].shape[1] or src.shape[1]>static[k].shape[2]:
                raise ValueError("段 %s 超容量：载荷 %s > 图槽 %s —— ⛔ 不静默裁剪" % (k,tuple(src.shape),tuple(static[k].shape[1:])))
            if _TRACE: print("T_TENSOR ms=%.3f" % ((__import__('time').time()-_t7)*1000), flush=True)
            _t7=__import__('time').time()
            static[k][0,:src.shape[0],:src.shape[1]]=src          # ⭐ 三维张量必须写全 3 个下标（0=批次维）；⛔ 不 min() 静默裁剪
            _tc2+=__import__('time').time()-_t7
        _PM['tensor']=_tt*1000; _PM['copy']=_tc2*1000
        if _TRACE: print("T_COPY ms=%.3f" % ((__import__('time').time()-_t8)*1000), flush=True)
        _t5=__import__('time').time()
        g.replay()   # ⭐ 首请求计时点（唯一化）
        _MK['replay']=(__import__('time').time()-_t5)*1000
        _PM['replay']=_MK['replay']
        if _FIRST_PRINT: _FIRST_PRINT=False; print("FIRST_SEGS "+str(_MK), flush=True)
        return out,N,t                                             # ⭐ 回传真实 N/档位：主循环只从这里取（避免两处各自推导）
    else:                                                 # ⭐ 退回原路：直接前向（张量每次新建）
        segs,mask=mk(t)
        mask[0,N:mask.shape[1]-CTX]=True                       # ⭐ 同图路：只标节点区填充位（True=填充/无效）
        for k,v in obs['segs'].items():
            src=torch.tensor(v,device=dev)
            if src.dim()!=2: raise ValueError("段 %s 必须是二维 (行,宽)，实际 %s" % (k,tuple(src.shape)))
            if src.shape[0]>segs[k].shape[1] or src.shape[1]>segs[k].shape[2]:
                raise ValueError("段 %s 超容量：载荷 %s > 图槽 %s —— ⛔ 不静默裁剪" % (k,tuple(src.shape),tuple(segs[k].shape[1:])))
            segs[k][0,:src.shape[0],:src.shape[1]]=src            # ⭐ 同图路：3 个下标（0=批次维）
        with torch.no_grad(): return model(segs,mask),N,t       # ⭐ 回传真实 N/档位（同图路口径）
_t0=__import__('time').time()
for _t in TIERS:
    get_graph(_t)
torch.cuda.synchronize()
print("WARMUP_DONE ms=%d tiers_ready=%d" % ((__import__('time').time()-_t0)*1000, len(_graphs)), flush=True)
_tf=__import__('time').time()
_w,_,_=forward({'N':TIERS[0],'segs':{'node':[[0.0]*10]*TIERS[0],'opp':[[0.0]*15]*N_OPP,'bullet':[[0.0]*6]*64,'item':[[0.0]*6]*8,'global':[[0.0]*38],'mem':[[0.0]*256]*4}})
torch.cuda.synchronize()
print("WARMUP_FWD ms=%d n_out=%d" % ((__import__('time').time()-_tf)*1000, len(_w)), flush=True)
_ws=torch.randn(64,device=dev); _wl=torch.log_softmax(_ws,dim=-1)
_ = int(torch.multinomial(torch.exp(_wl),1).item())
torch.cuda.synchronize()
print("WARMUP_SAMPLE ok", flush=True)
for line in sys.stdin:
    line=line.strip()
    if not line: continue
    try:
        _T0=__import__('time').time()                             # ⭐ 探针：请求开始（读入一行之后）
        _PM.clear()                                               # ⭐ 每请求清空（防上一请求的键残留）
        _t6=_T0
        d=(_orjson.loads(line) if ('json' in _FAST and _orjson is not None) else json.loads(line))
        # ⭐ 探针（2026-10-18 性能代理）：逐请求覆盖 VT_FAST —— 让 A/B 两种开关在【同一个进程、同一批 GPU 时钟】下轮转，
        #   否则跨进程的中位数会被 GPU 降频/系统噪声吃掉（实测同一份代码两次跑 srv 2.88 vs 3.43 ms）。
        #   ⛔ 生产载荷不含 `_fast` ⟹ 一行也不走这里
        if isinstance(d, dict) and '_fast' in d:
            _FAST = set(x.strip() for x in str(d.get('_fast') or '').split(',') if x.strip())
        _PM['parse']=(__import__('time').time()-_t6)*1000
        if _TRACE: print("T_LOADS ms=%.3f" % ((__import__('time').time()-_t6)*1000), flush=True)
        # ⭐⭐ 记忆递推（按设计文档 记忆槽-数据格式设计-2026-10-15 §四）
        _mem_on = int(d.get('mem_on', 0) or 0)
        _phase = str(d.get('phase', 'B'))
        if _phase not in ('A', 'B'): raise ValueError("phase 只能是 A/B，实际 %r" % (_phase,))
        _rid = d.get('round_id', None)
        if _rid is not None and _rid != _MEM_ROUND:
            _MEM_ROUND = _rid
            _MEM['A'] = torch.zeros(2, 256, device=dev); _MEM['B'] = torch.zeros(2, 256, device=dev)
            print("MEM_RESET round_id=%s" % (_rid,), file=sys.stderr, flush=True)
        if _MEM['A'] is None: _MEM['A'] = torch.zeros(2, 256, device=dev); _MEM['B'] = torch.zeros(2, 256, device=dev)
        _tm0=__import__('time').time()
        if _mem_on:
            _mem_rows = torch.cat([_MEM['A'], _MEM['B']], 0)
            d.setdefault('segs', {})['mem'] = _mem_rows.detach().cpu().tolist()
        elif 'mem' in _FAST:
            #    ⚠️ mem_on=0 + 开 `mem` ⟹ 既不建 _mem_rows、也不发 mem 段：
            #       图槽每帧已 `static['mem'].zero_()` ⟹ 喂进去的还是全零（语义相同），省 1 次 cuda 分配 + 1 次 H2D 拷贝
            _mem_rows = None
        else:
            _mem_rows = torch.zeros(4, 256, device=dev)   # ① mem_on=0 ⇒ 喂零（老口径）
            d.setdefault('segs', {})['mem'] = _mem_rows.detach().cpu().tolist()
        _PM['mem']=(__import__('time').time()-_tm0)*1000
        out,N_real,tier=forward(d)                             # ⭐ forward 回传 (out, 真实N, 档位)
        assert len(out)==4, "期望 4 个输出 v/fire/fail/logp_all、实际 %d" % len(out)
        sc=out[3]                                             # ⭐ out=(v=head_node(池化h), fire, fail, logp_all)
        if sc.dim()==2: sc=sc[0]                              # ⭐ B=1 ⟹ (T,)；旧代码 gp.dim()>2 对 (1,T) 不成立 ⟹ 曾把 gp[:1]=整条 token 序列当候选
        elif sc.dim()!=1: raise ValueError("动作头形状异常 %s" % (tuple(sc.shape),))
        if sc.shape[0]!=tier+CTX: raise ValueError("动作头长度 %d != 档位 %d + %d（上下文 token）" % (sc.shape[0],tier,CTX))
        _t9=__import__('time').time()
        logits=sc[1:N_real].float()   # ⭐ D11：动作空间 [1,N)（行 0 = no-op 移出）                            # ⭐ 候选集 = 节点区【前 N_real 个】（78 个上下文 token 不是选项）
        logp_all=torch.log_softmax(logits,dim=-1)             # ⭐ 只在真实节点上重新归一 = 对原始节点分数做 log_softmax（节点区 mask 全 False、无 -inf）⟹ lp 与该分布同口径
        # ⭐ 裁决 B（父代理 2026-10-17）：采样种子由载荷 d['seed'] 给（同 seed ⟹ 同结果、可复现）；
        #    没给 ⟹ 用 时间戳^请求计数 换着来（⛔ 不再固定 12345：那会让同观测永远同动作、探索死掉）
        try: _seed=int(d.get('seed') or 0)
        except Exception: raise ValueError("seed 字段非整数：%r" % (d.get('seed'),))
        if _seed: torch.manual_seed(_seed)
        else:
            _REQN+=1
            torch.manual_seed((__import__('time').time_ns() ^ (_REQN*2654435761)) & 0x7fffffff)
        idx=int(torch.multinomial(torch.exp(logp_all),1).item())+1
        if os.environ.get('VT_PROBE_SRV')=='1':
            _tv,_ti=torch.topk(logits,5)
            print('SRV_CAND N_real=%d cand=%d top5=%s rows=%s picked=%d' % (N_real, int(logits.numel()), [round(float(x),3) for x in _tv], [int(x)+1 for x in _ti], idx), file=sys.stderr, flush=True)   # ⭐ 上面已去掉行 0 ⇒ 行号 +1
        _PM['post']=(__import__('time').time()-_t9)*1000      # ⭐ 探针：logits/采样/logp/v/fire 头（含 log_softmax 与 multinomial 的隐式同步）
        _tA=__import__('time').time()
        if 'argmax' not in _FAST:                                      # ⭐ 它的结果**只**给下面这行 _TRACE 打印用（不参与任何输出）
            _argidx=int(torch.argmax(logits).item())
            if _TRACE: print("T_ARGMAX ms=%.3f (对照: 仅 argmax+item, 未采用)" % ((__import__('time').time()-_tA)*1000), flush=True)
        if _TRACE: print("T_SAMPLE ms=%.3f" % ((__import__('time').time()-_t9)*1000), flush=True)
        if not (0<=idx<N_real): raise AssertionError("nodeId=%d 越界 [0,%d) —— ⛔ 显式失败、不静默截断" % (idx,N_real))
        _PM['t_scalars0']=(__import__('time').time()-_T0)*1000
        if 'sync' in _FAST:
            # ⭐ 把 3 个标量（lp / v / fire logit）**合成 1 次** GPU→CPU 读取（每次 .item()/float() 都是一次全device 同步）
            #   数值逐位相同：stack 只搬 float32 位型，`float()` 与 `.tolist()` 的 float32→double 转换是同一个
            _sv=torch.stack([logp_all[idx-1].reshape(()), out[0].mean().reshape(()), out[1].view(-1)[0].reshape(())]).cpu().tolist()
            lp=float(_sv[0]); v=float(_sv[1]); _flog=float(_sv[2])
        else:
            lp=float(logp_all[idx-1]); v=float(out[0].mean())   # ⭐ logp_all 已是 [1,N) 的分布 ⇒ 下标 -1       # ⭐ v=out[0]=价值头 head_node(池化h)；⛔ 语义不变
        # ⭐ 开火头 out[1]（2026-10-17 派单②）：语义 = "本帧要不要开火"的策略信号（B=1 ⟹ 单个 logit）
        #    ⛔ 不动 out[0]/out[3] 语义（那是已验收口径）；采集器拿 fire=1 去拼 picks[1] 射击帧
        if 'sync' not in _FAST: _flog = float(out[1].view(-1)[0])   # ⭐ 'sync' 时已在上面那次合并读取里拿到
        _PM['t_scalars1']=(__import__('time').time()-_T0)*1000
        _fprob = float(torch.sigmoid(torch.tensor(_flog)))
        # ⭐⭐ head_fire 真采样（Bernoulli，用载荷 seed）⇒ lp_fire / fire_ent 可得漓度
        _fbit = int(torch.bernoulli(torch.tensor(_fprob)).item())
        fire = _fbit
        _p = min(max(_fprob, 1e-6), 1 - 1e-6)
        lp_fire = float(math.log(_p) if fire == 1 else math.log(1.0 - _p))
        fire_ent = float(-(_p * math.log(_p) + (1 - _p) * math.log(1 - _p)))                       # ⭐ 阈值 0.5（确定性、不额外消耗采样 RNG）
        _F1 += fire; _F0 += (1 - fire)
        if (not _FIRE_PRINTED) and (_F1 + _F0) >= _FIRE_DIST_AT:
            _FIRE_PRINTED = True
            print("FIRE_DIST n=%d fire1=%d(%.1f%%) fire0=%d 阈值=0.5 本例_logit=%.4f 本例_p=%.4f"
                  % (_F1 + _F0, _F1, 100.0 * _F1 / max(1, _F1 + _F0), _F0, _flog, _fprob),
                  file=sys.stderr, flush=True)
        _PM['t_fire1']=(__import__('time').time()-_T0)*1000
        # ⭐⭐ 写回自己那一份（只在 mem_on=1 时推进；⏔t 隐式推进）
        if _mem_on:
            _g = _graphs.get(pick_tier(N_real), None)
            if _g is None: raise ValueError('记忆写头：拿不到对应档位的图槽')
            _st, _mk = _g[1], _g[2]
            _tmg=__import__('time').time()
            _mg = get_mem_graph(N_real) if 'memg' in _FAST else None
            if _mg is not None:
                _mg[0].replay()
                # ⚠️ 必须 clone：图输出是**静态缓冲**，不 clone 的话 A/B 两份会指到同一块内存
                #   （原实现每次写的是"本相位那份"的 2×256，两份各自独立）
                _MEM[_phase] = _mg[1][0].detach().clone()
            else:
                _w = model.write_mem(_st, _mk)          # (1,2,256)
                _MEM[_phase] = _w[0].detach()
            _PM['memw']=(__import__('time').time()-_tmg)*1000
        global _MEM_PRINTED
        _MEM_PRINTED = globals().get("_MEM_PRINTED", 0) + 1
        if _MEM_PRINTED % 200 == 1:
            print("MEM_STATE n=%d phase=%s mem_on=%d A_max=%.4f B_max=%.4f fedA_max=%.4f fedB_max=%.4f" % (
                _MEM_PRINTED, _phase, _mem_on, float(_MEM["A"].abs().max()), float(_MEM["B"].abs().max()),
                (float(_mem_rows[:2].abs().max()) if _mem_rows is not None else float('nan')),
                (float(_mem_rows[2:].abs().max()) if _mem_rows is not None else float('nan'))), file=sys.stderr, flush=True)
        # 对拍：回包告诉客户端「这帧到底喂了什么」（mem_on=0 且开 `echo` ⟹ 不取：它必然是 4×256 个零）
        _echo = _mem_rows.detach().cpu().numpy().tolist() if (_mem_rows is not None and not ('echo' in _FAST and not _mem_on)) else None
        # ⭐⭐ A 相（生长）：用 head_grow 在「当前可行生长节点」里采 1 个（grow_ok 掩码）
        # ⭐⭐ 射击帧形态（C8/D3）：对「本段可执行帧」逐帧 Bernoulli 采样（上限 K_FIRE）
        _ff = None
        if _phase == 'B':
            _cand = d.get('fire_cand') or []
            if _cand:
                _K = int(d.get('fire_k', 4))
                _bits = []; _lpf = 0.0; _kept = []
                for _c in _cand:
                    _b = int(torch.bernoulli(torch.tensor(_fprob)).item())
                    _bits.append(_b)
                    _lpf += math.log(_p) if _b == 1 else math.log(1.0 - _p)
                    _kept.append({"nodeId": int(_c.get("nodeId")), "back": int(_c.get("back", 0))})   # ⭐ 不裁剪：保留桥的全部候选（冗余兜游标不确定性）
                _ff = {"fire_frames": _kept, "lp_fire": float(_lpf), "fire_ent": float(len(_cand) * (-(_p * math.log(_p) + (1 - _p) * math.log(1 - _p)))), "fire_ncand": len(_cand), "fire_kept": len(_kept)}
        _PM['t_mem_echo']=(__import__('time').time()-_T0)*1000
        _grow = None
        if _phase == 'A':
            _ok = d.get('grow_ok') or []
            if len(_ok) != N_real: raise ValueError("grow_ok 长度 %d != N_real %d（⏔t 静默补齐）" % (len(_ok), N_real))
            _allow = torch.tensor(_ok, device=dev).bool()
            if int(_allow.sum().item()) < 1: raise ValueError("没有可生长节点（D11：不能生长时不应调 A）")
            _g = _graphs.get(pick_tier(N_real), None)
            _st, _mk = _g[1], _g[2]
            _gs = (model_a if NET_SPLIT else model).grow_scores(_st, _mk)[0][:N_real].float()   # ⭐ 双网时 A 相走 model_a          # 逐 token logits → 取 node 区
            _gm = torch.where(_allow, _gs, torch.full_like(_gs, float('-inf')))
            _glp = torch.log_softmax(_gm, dim=-1)
            try: _seed2 = int(d.get('seed') or 0)
            except Exception: _seed2 = 0
            if _seed2: torch.manual_seed(_seed2)
            _gi = int(torch.multinomial(_glp.exp(), 1).item())
            _p = _glp.exp(); _ent = float(-(_p * torch.where(_p > 0, _glp, torch.zeros_like(_glp))).sum())
            _grow = {"grow_nodeId": _gi, "lp_grow": float(_glp[_gi]), "ent_grow": _ent, "grow_ok_count": int(_allow.sum().item())}
        _resp=({"grow": _grow} if _grow else {}) | ({"fire_sel": _ff} if _ff else {}) | {"lp":lp,"v":v,"fire":fire,"lp_fire":lp_fire,"fire_ent":fire_ent,"fire_p":_fprob,"nodeId":idx,"mem_echo":_echo,"mode":("graph" if USE_GRAPH else "direct"),"payload":PAYLOAD_KIND}
        if 'echo' in _FAST and not _mem_on: _resp.pop('mem_echo', None)   # ⭐ mem_on=0 ⟹ echo 全是零、1024 个数（5.3KB 回包）纯冗余
        _tj=__import__('time').time()
        _out=json.dumps(_resp)
        _PM['dumps']=(__import__('time').time()-_tj)*1000
        if _PROBE_MS:
            _PM['total']=(__import__('time').time()-_T0)*1000; _PM['out_bytes']=len(_out)
            # ⭐ 只在 `_pm` 字段里追加，一个字节都不动原有键值（协议不变：仍是一行 JSON）
            _out='{"_pm":'+json.dumps(_PM)+','+_out[1:]
        print(_out,flush=True)
    except Exception as e:
        print(json.dumps({"lp":None,"v":None,"err":str(e)[:240]}),flush=True)   # ⭐ 诊断信息尽量带全（仍是一行 JSON，协议不变）
