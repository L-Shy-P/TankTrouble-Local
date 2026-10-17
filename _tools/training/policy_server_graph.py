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
model=nv2.NetV2().to(dev).eval()
# ⭐ 权重加载（搭车项，2026-10-17 父代理裁定）：VT_CKPT 指向的 ckpt 存在才加载；诊断一律走 stderr（⛔ 不破一问一答协议）
_CKPT=os.environ.get('VT_CKPT','')
if _CKPT and os.path.isfile(_CKPT):
    _ck=torch.load(_CKPT,map_location=dev,weights_only=True)      # 自己的 ckpt；weights_only=True 更安全
    if not (isinstance(_ck,dict) and 'model' in _ck):
        raise ValueError("ckpt 缺 'model' 键（实际键名 %s）—— ⛔ 不猜" % (sorted(_ck.keys()) if isinstance(_ck,dict) else type(_ck).__name__))
    _r = model.load_state_dict(_ck['model'], strict=False)   # ⭐ 记忆头是新增的 ⇒ strict=False（老权重一位不动）
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
N_OPP = nv2.N_OPP                                          # ⭐ opp 槽行数【唯一来源】= net_v2_fixed.py:8（⛔ 不在这里另写一个数）
CTX = N_OPP + nv2.N_BUL + nv2.N_ITM + nv2.N_GLB + nv2.N_MEM   # 上下文 token 数：opp1 时=78，opp8 时=85
assert CTX == 85, "CTX_TOKENS=%d≠85 ⟹ 与 vt_buffer.py 的 CTX_TOKENS 漂了，别放行" % CTX
print("CTX_TOKENS", CTX, "N_OPP", N_OPP, "POS_NORM", getattr(nv2, 'POS_NORM', '?'), flush=True)   # ⚠️ 常量必须开机打印（铁律二）；POS_NORM 来源 = net_v2_fixed.py:9（⛔ 不在这里另写）
def mk(N):                                                # ⭐ 裁剪唯一入口（张量与掩码同长）
    segs={'node':torch.zeros(B,N,10,device=dev),'opp':torch.zeros(B,N_OPP,15,device=dev),'bullet':torch.zeros(B,64,7,device=dev),
          'item':torch.zeros(B,8,6,device=dev),'global':torch.zeros(B,1,38,device=dev),'mem':torch.zeros(B,4,256,device=dev)}
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
        for _k in static: static[_k].zero_()                      # ⭐ 各段每次请求先清零：载荷给几行就写几行、其余补零
        #    （图槽复用 ⟹ 不清零会残留上一请求的 opp/bullet/item 行；训练侧是补零 ⟹ 不清零就变"两套输入分布"）
        for k,v in obs['segs'].items():                   # ⭐ 原地 copy_（别新建张量）
            _t7=__import__('time').time()
            src=torch.tensor(v,device=dev)   # ⭐ 图路（计时点）
            if src.dim()!=2: raise ValueError("段 %s 必须是二维 (行,宽)，实际 %s" % (k,tuple(src.shape)))
            if src.shape[0]>static[k].shape[1] or src.shape[1]>static[k].shape[2]:
                raise ValueError("段 %s 超容量：载荷 %s > 图槽 %s —— ⛔ 不静默裁剪" % (k,tuple(src.shape),tuple(static[k].shape[1:])))
            if _TRACE: print("T_TENSOR ms=%.3f" % ((__import__('time').time()-_t7)*1000), flush=True)
            static[k][0,:src.shape[0],:src.shape[1]]=src          # ⭐ 三维张量必须写全 3 个下标（0=批次维）；⛔ 不 min() 静默裁剪
        if _TRACE: print("T_COPY ms=%.3f" % ((__import__('time').time()-_t8)*1000), flush=True)
        _t5=__import__('time').time()
        g.replay()   # ⭐ 首请求计时点（唯一化）
        _MK['replay']=(__import__('time').time()-_t5)*1000
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
        _t6=__import__('time').time()
        d=json.loads(line)
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
        _mem_rows = torch.cat([_MEM['A'], _MEM['B']], 0) if _mem_on else torch.zeros(4, 256, device=dev)   # ① mem_on=0 ⇒ 喂零
        d.setdefault('segs', {})['mem'] = _mem_rows.detach().cpu().tolist()
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
        idx=int(torch.multinomial(torch.exp(logp_all),1).item())+1   # ⭐ 上面已去掉行 0 ⇒ 行号 +1
        _tA=__import__('time').time()
        _argidx=int(torch.argmax(logits).item())
        if _TRACE: print("T_ARGMAX ms=%.3f (对照: 仅 argmax+item, 未采用)" % ((__import__('time').time()-_tA)*1000), flush=True)
        if _TRACE: print("T_SAMPLE ms=%.3f" % ((__import__('time').time()-_t9)*1000), flush=True)
        if not (0<=idx<N_real): raise AssertionError("nodeId=%d 越界 [0,%d) —— ⛔ 显式失败、不静默截断" % (idx,N_real))
        lp=float(logp_all[idx-1]); v=float(out[0].mean())   # ⭐ logp_all 已是 [1,N) 的分布 ⇒ 下标 -1       # ⭐ v=out[0]=价值头 head_node(池化h)；⛔ 语义不变
        # ⭐ 开火头 out[1]（2026-10-17 派单②）：语义 = "本帧要不要开火"的策略信号（B=1 ⟹ 单个 logit）
        #    ⛔ 不动 out[0]/out[3] 语义（那是已验收口径）；采集器拿 fire=1 去拼 picks[1] 射击帧
        _flog = float(out[1].view(-1)[0])
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
        # ⭐⭐ 写回自己那一份（只在 mem_on=1 时推进；⏔t 隐式推进）
        if _mem_on:
            _g = _graphs.get(pick_tier(N_real), None)
            if _g is None: raise ValueError('记忆写头：拿不到对应档位的图槽')
            _st, _mk = _g[1], _g[2]
            _w = model.write_mem(_st, _mk)          # (1,2,256)
            _MEM[_phase] = _w[0].detach()
        _echo = _mem_rows.detach().cpu().numpy().tolist()   # 对拍：回包告诉客户端「这帧到底喂了什么」
        # ⭐⭐ A 相（生长）：用 head_grow 在「当前可行生长节点」里采 1 个（grow_ok 掩码）
        _grow = None
        if _phase == 'A':
            _ok = d.get('grow_ok') or []
            if len(_ok) != N_real: raise ValueError("grow_ok 长度 %d != N_real %d（⏔t 静默补齐）" % (len(_ok), N_real))
            _allow = torch.tensor(_ok, device=dev).bool()
            if int(_allow.sum().item()) < 1: raise ValueError("没有可生长节点（D11：不能生长时不应调 A）")
            _g = _graphs.get(pick_tier(N_real), None)
            _st, _mk = _g[1], _g[2]
            _gs = model.grow_scores(_st, _mk)[0][:N_real].float()          # 逐 token logits → 取 node 区
            _gm = torch.where(_allow, _gs, torch.full_like(_gs, float('-inf')))
            _glp = torch.log_softmax(_gm, dim=-1)
            try: _seed2 = int(d.get('seed') or 0)
            except Exception: _seed2 = 0
            if _seed2: torch.manual_seed(_seed2)
            _gi = int(torch.multinomial(_glp.exp(), 1).item())
            _p = _glp.exp(); _ent = float(-(_p * torch.where(_p > 0, _glp, torch.zeros_like(_glp))).sum())
            _grow = {"grow_nodeId": _gi, "lp_grow": float(_glp[_gi]), "ent_grow": _ent, "grow_ok_count": int(_allow.sum().item())}
        print(json.dumps(({"grow": _grow} if _grow else {}) | {"lp":lp,"v":v,"fire":fire,"lp_fire":lp_fire,"fire_ent":fire_ent,"fire_p":_fprob,"nodeId":idx,"mem_echo":_echo,"mode":("graph" if USE_GRAPH else "direct"),"payload":PAYLOAD_KIND}),flush=True)
    except Exception as e:
        print(json.dumps({"lp":None,"v":None,"err":str(e)[:240]}),flush=True)   # ⭐ 诊断信息尽量带全（仍是一行 JSON，协议不变）
