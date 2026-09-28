import sys, json
import numpy as np
sys.stdout.reconfigure(encoding="utf-8")
d = json.load(open(sys.argv[1], encoding="utf-8"))  # T48c 复审脚本 t48crev-pulsean.py 的副本
for sc, res in d.items():
    print("==", sc)
    for m, segs in res.items():
        dm, dt_abs, dt_p95, nfl, dtm = [], [], [], 0, []
        for seg in segs:
            mean = np.array([r["mean"] for r in seg]); st = np.array([r["strobe"] for r in seg]); T = np.array([r["tiles"] for r in seg])
            t = np.array([r["t"] for r in seg]); dtm.append(np.median(np.diff(t)))
            # 频闪帧与它之前最近的非频闪帧比（同一段、相距 ≤ 60 ms）
            for i in range(1, len(seg)):
                if st[i] > 0:
                    j = i - 1
                    while j >= 0 and st[j] > 0: j -= 1
                    if j < 0 or t[i] - t[j] > 60: continue
                    nfl += 1
                    dm.append(mean[i] - mean[j])
                    dtile = T[i] - T[j]
                    dt_abs.append(np.abs(dtile).mean()); dt_p95.append(np.percentile(dtile, 95))
            # 对照：非频闪相邻帧的分块变化
        base = []
        for seg in segs:
            st = np.array([r["strobe"] for r in seg]); T = np.array([r["tiles"] for r in seg]); t = np.array([r["t"] for r in seg])
            for i in range(1, len(seg)):
                if st[i] == 0 and st[i - 1] == 0: base.append(np.abs(T[i] - T[i - 1]).mean())
        dm = np.array(dm)
        print(f"  {m:8s} 帧间隔中位 {np.median(dtm):.1f} ms；频闪帧 {nfl}：城区均值 − 闪前 = 中位 {np.median(dm):+.2f} 最大 {dm.max():+.2f}；分块 |Δ| 中位 {np.median(dt_abs):.2f}、分块 Δ p95 中位 {np.median(dt_p95):+.2f}；对照（非频闪相邻帧）分块 |Δ| 中位 {np.median(base):.2f}")
