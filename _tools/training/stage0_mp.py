# -*- coding: utf-8 -*-
"""① 阶段0 多进程吞吐实测：1/2/4 路各跑 SEC 秒，聚合 SPS 并折算"""
import os, subprocess, sys, time, re
SEC=os.environ.get("S0_SEC","4")
def run(nw):
    env=dict(os.environ); env["S0_SEC"]=SEC; env["PYTHONIOENCODING"]="utf-8"
    ps=[subprocess.Popen([sys.executable,"_tools/training/stage0_worker.py"],stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,env=env,text=True) for _ in range(nw)]
    tot=0.0; det=[]
    for p in ps:
        out,_=p.communicate()
        m=re.search(r"sps=([0-9.]+)",out or "")
        if m: tot+=float(m.group(1)); det.append(m.group(1))
        else: det.append("FAIL")
    return tot,det
for nw in (1,2,4):
    t=time.time(); tot,det=run(nw)
    print("MP workers=%d 各sps=%s 合计=%.2f sps (墙钟 %.1fs)  ⟹ 100万步 %.1f h / 1亿步 %.0f h"%(
        nw,",".join(det),tot,time.time()-t,tot and 1e6/tot/3600, tot and 1e8/tot/3600))
