"""NIGHT-AP-1 审查：切换点 HDR 比较。用法：python NAP1rev-hdrdiff.py <目录>"""
import json, sys
import numpy as np

sys.stdout.reconfigure(encoding="utf-8")
d = sys.argv[1]


def ld(n):
    m = json.load(open(f"{d}/{n}.json"))
    return np.fromfile(f"{d}/{n}.f32", dtype=np.float32).reshape(m["h"], m["w"], 4)[..., :3]


Y = lambda a: a[..., 0] * 0.2126 + a[..., 1] * 0.7152 + a[..., 2] * 0.0722
s, m, s2, o = ld("sun"), ld("moon"), ld("sun2"), ld("old")
H = s.shape[0]
for lab, sl in [("整图", slice(None)), ("上半（远景/天空）", slice(H // 2, H)), ("下半（近处）", slice(0, H // 2))]:
    a, b, c, e = Y(s[sl]), Y(m[sl]), Y(s2[sl]), Y(o[sl])
    rel = lambda x, y: np.abs(x - y) / np.maximum(y, 1e-12)
    print(f"{lab}: 均亮 sun {a.mean():.3e} moon {b.mean():.3e} old {e.mean():.3e} | moon/sun 相对差 均值 {rel(b, a).mean():.4f} p99 {np.percentile(rel(b, a), 99):.4f} 最大 {rel(b, a).max():.3f} | 噪声底 sun2/sun {rel(c, a).mean():.4f} | sun/old 均值 {rel(a, e).mean():.4f}")
