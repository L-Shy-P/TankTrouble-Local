# -*- coding: utf-8 -*-
"""放行闸门（preflight gate）—— 整夜训练开跑前必须全绿。

父代理 2026-10-17 夜定：⛔ 不许"看着像在跑"就放行；必须逐条机器判定。

判据（任一红 ⟹ 退出码非 0、⛔ 不许开整夜跑）：
  G-1 服务端能起（读到 WARMUP_SAMPLE 为止；打印实际行数）
  G-2 一问一答协议：每次请求【恰好】读回一行 JSON（多行/少行都算红）
  G-3 候选集越界：对 N=60/300/500/700/1000 各 M 次，nodeId 必须【全部 < N】
  G-4 lp 有限：每个回复的 lp 必须是有限浮点（不是 None/NaN/inf）
  G-5 显式拒绝：缺 N / N 与行数不一致 / 超最高档 ⟹ 服务端必须回 err（⛔ 不许静默顶替）

用法：py -3.13 _tools/gates/preflight.py [--n 25] [--ckpt <path>]
产出：D:/vt_run/gates/preflight_<tag>.log （同时打到 stdout）
"""
import argparse, json, os, random, subprocess, sys, time

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SERVER = os.path.join(ROOT, "_tools", "training", "policy_server_graph.py")
OUTDIR = r"D:/vt_run/gates"
NS = [60, 300, 500, 700, 1000]
TIER_MAX = 1008

logf = None
def log(*a):
    s = " ".join(str(x) for x in a)
    print(s, flush=True)
    if logf: logf.write(s + "\n"); logf.flush()

def start_server(ckpt=None):
    env = dict(os.environ); env["PYTHONIOENCODING"] = "utf-8"
    if ckpt: env["VT_CKPT"] = ckpt
    p = subprocess.Popen([sys.executable, SERVER], cwd=ROOT, env=env,
                         stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                         text=True, encoding="utf-8", errors="replace", bufsize=1)
    hdr = []
    t0 = time.time()
    while time.time() - t0 < 600:
        ln = p.stdout.readline()
        if not ln: break
        hdr.append(ln.rstrip("\n"))
        if "WARMUP_SAMPLE" in ln: break
    return p, hdr

def payload(N, seed, mode="ok"):
    rnd = random.Random(seed)
    rows = [[rnd.uniform(-1, 1) for _ in range(10)] for _ in range(N)]
    g = [rnd.uniform(-1, 1) for _ in range(38)]
    if mode == "ok":       return {"N": N, "seed": seed, "segs": {"node": rows, "global": [g]}}
    if mode == "noN":      return {"seed": seed, "segs": {"node": rows, "global": [g]}}
    if mode == "mismatch": return {"N": N + 7, "seed": seed, "segs": {"node": rows, "global": [g]}}
    if mode == "toobig":   return {"N": TIER_MAX + 1, "seed": seed,
                                   "segs": {"node": [[0.0]*10]*(TIER_MAX+1), "global": [g]}}

def ask(p, pl):
    p.stdin.write(json.dumps(pl) + "\n"); p.stdin.flush()
    return p.stdout.readline().strip()

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=25)
    ap.add_argument("--ckpt", default=None)
    ap.add_argument("--tag", default=time.strftime("%H%M%S"))
    a = ap.parse_args()
    os.makedirs(OUTDIR, exist_ok=True)
    global logf
    logf = open(os.path.join(OUTDIR, "preflight_%s.log" % a.tag), "w", encoding="utf-8")

    red = []
    log("=== preflight tag=%s n=%d ckpt=%s ===" % (a.tag, a.n, a.ckpt or "(none)"))

    p = None
    try:
        p, hdr = start_server(a.ckpt)
        log("G-1 BOOT_LINES=%d" % len(hdr))
        for i, h in enumerate(hdr): log("  BOOT[%d] %s" % (i, h))
        if not any("WARMUP_SAMPLE" in h for h in hdr):
            red.append("G-1 服务端没起完（没读到 WARMUP_SAMPLE）"); raise SystemExit(1)
        log("G-1 OK")

        # G-2/G-3/G-4
        for N in NS:
            oob = 0; uniq = set(); bad_proto = 0; bad_lp = 0
            for k in range(a.n):
                pl = payload(N, 1000*N + k)
                r = ask(p, pl)
                try:
                    d = json.loads(r)
                except Exception:
                    bad_proto += 1; continue
                if d.get("err"): bad_proto += 1; continue
                nid = d.get("nodeId"); lp = d.get("lp")
                if not isinstance(nid, int): bad_proto += 1; continue
                uniq.add(nid)
                if nid >= N or nid < 0: oob += 1
                if lp is None or not isinstance(lp, float) or lp != lp or abs(lp) == float("inf"): bad_lp += 1
            tag = "OK" if (oob == 0 and bad_proto == 0 and bad_lp == 0) else "RED"
            log("G-3/G-4 N=%-5d oob=%d/%d uniq=%d bad_proto=%d bad_lp=%d  [%s]"
                % (N, oob, a.n, len(uniq), bad_proto, bad_lp, tag))
            if oob: red.append("G-3 N=%d 越界 %d/%d" % (N, oob, a.n))
            if bad_lp: red.append("G-4 N=%d lp 非有限 %d/%d" % (N, bad_lp, a.n))
            if bad_proto: red.append("G-2 N=%d 回复异常 %d/%d" % (N, bad_proto, a.n))

        # G-5 显式拒绝
        for mode in ("noN", "mismatch", "toobig"):
            r = ask(p, payload(300, 7, mode))
            try: d = json.loads(r)
            except Exception: d = {"__parse__": "fail"}
            ok = bool(d.get("err"))
            log("G-5 %-9s -> err=%s  [%s]" % (mode, d.get("err"), "OK" if ok else "RED"))
            if not ok: red.append("G-5 %s 没有显式拒绝" % mode)

    finally:
        if p:
            try: p.terminate()
            except Exception: pass
            try:
                err = p.stderr.read() or ""
                err = err.strip()
                if err: log("--- server stderr（末 1500 字）---"); log(err[-1500:])
            except Exception: pass
        pass  # ⚠️ 不在这里 close：下面还要打 RESULT（曾因此抛 ValueError: I/O operation on closed file）

    log("")
    if red:
        log("RESULT RED（%d 条）:" % len(red))
        for x in red: log("  ✗ " + x)
        log("⛔ 不许开整夜跑")
        if logf: logf.close()
        sys.exit(1)
    log("RESULT GREEN —— 五条闸门全过")
    if logf: logf.close()
    sys.exit(0)

if __name__ == "__main__":
    main()
