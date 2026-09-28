"""PERF-STORM：切程序一致性。同一机位、同一片层积云海，有雷暴（天气程序）与没有雷暴（默认程序）的云缓冲读回
按距离分带比较 Y 与 α（只取两边都是浓云海的像素）。old = master、cur = 本分支；比值越接近 1，雷暴出现 / 消失时近处云海越不跳。
用法：python handoff/PERF-STORM-switch.py <ab 输出目录> [storm 场景 sea 场景]
"""
import json
import os
import sys
from array import array

sys.stdout.reconfigure(encoding="utf-8")
root = sys.argv[1]
pairs = [("sw-storm-sc-low", "sw-sea-sc-low"), ("sw-storm-sc", "sw-sea-sc")]


def load(job, var):
    p = os.path.join(root, job, f"{var}.cloud.f32")
    a = array("f")
    with open(p, "rb") as f:
        a.frombytes(f.read())
    meta = json.load(open(os.path.join(root, job, f"{var}.cloud.json"), encoding="utf-8"))
    return a, meta["W"], meta["H"]


BANDS = [(0, 20), (20, 40), (40, 60), (60, 90), (90, 1e9)]
for js, jc in pairs:
    dist, W, H = load(jc, "dist")
    print(f"== {js} 对 {jc}（Y 比 = 有雷暴 / 无雷暴，中位；|Δα| 均值；只取两边 α > 0.9 且深度可读的像素）")
    print("| 变体 | " + " | ".join(f"{a}–{b if b < 1e9 else '∞'} km" for a, b in BANDS) + " |")
    print("|---|" + "---:|" * len(BANDS))
    for var in ["old", "cur"]:
        s, _, _ = load(js, var)
        c, _, _ = load(jc, var)
        cells = []
        for lo, hi in BANDS:
            rs = []
            da = 0.0
            n = 0
            for k in range(W * H):
                ac = c[2 * k]
                asn = s[2 * k]
                if ac < 0.9 or asn < 0.9:
                    continue
                d = dist[2 * k + 1] / max(dist[2 * k], 1e-6)
                if not (lo <= d < hi):
                    continue
                yc = c[2 * k + 1]
                if yc <= 0:
                    continue
                rs.append(s[2 * k + 1] / yc)
                da += abs(asn - ac)
                n += 1
            if n < 50:
                cells.append("—")
                continue
            rs.sort()
            cells.append(f"{rs[len(rs) // 2]:.3f}（n {n}，|Δα| {da / n:.4f}）")
        print(f"| {var} | " + " | ".join(cells) + " |")
