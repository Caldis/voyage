"""C11：机翼边缘放大对照（C11-ab.mjs 的 zoom 截图）。
每个 ic_ 姿态、每个 zoom 区：old 单帧 | old 16 帧平均 | new 单帧 | new 16 帧平均 | |new平均 − old平均|×8，各放大 3 倍拼成一行。
平均图之差看「平均有没有跨边造成光晕 / 阶梯」：跨边的话沿机翼轮廓会出现一条亮 / 暗线；只剩噪声说明边没被动。
用法：python C11_wing.py <ab 输出目录> <输出 png 目录>
"""
import os
import sys

import numpy as np
from PIL import Image

sys.stdout.reconfigure(encoding="utf-8")
root, out = sys.argv[1], sys.argv[2]
os.makedirs(out, exist_ok=True)
S = 3


def frames(d, z):
    fs = sorted(f for f in os.listdir(d) if f.startswith(f"z{z}_f"))
    return np.stack([np.asarray(Image.open(os.path.join(d, f)).convert("RGB")).astype(np.float64) for f in fs], 0)


def up(a):
    a = np.clip(a, 0, 255).astype(np.uint8)
    return np.asarray(Image.fromarray(a).resize((a.shape[1] * S, a.shape[0] * S), Image.NEAREST))


for job in sorted(os.listdir(root)):
    jd = os.path.join(root, job)
    if not job.startswith("ic_") or not os.path.isdir(jd):
        continue
    rows = []
    for z in range(8):
        if not any(f.startswith(f"z{z}_f") for f in os.listdir(os.path.join(jd, "old"))):
            break
        o, n = frames(os.path.join(jd, "old"), z), frames(os.path.join(jd, "new"), z)
        om, nm = o.mean(0), n.mean(0)
        d = np.abs(nm - om)
        # 单帧相邻像素差（亮度）
        L = lambda a: a @ [0.2126, 0.7152, 0.0722]
        adj = lambda a: (np.abs(np.diff(L(a), axis=1)).mean() + np.abs(np.diff(L(a), axis=0)).mean()) / 2
        print(f"{job} z{z}: 单帧 adj old {np.mean([adj(x) for x in o]):.3f} new {np.mean([adj(x) for x in n]):.3f}；"
              f"平均图 adj old {adj(om):.3f} new {adj(nm):.3f}；|平均差| 均值 {d.mean():.3f} 最大 {d.max():.1f} p99 {np.percentile(d, 99):.2f}")
        rows.append(np.concatenate([up(o[0]), up(om), up(n[0]), up(nm), up(d * 8)], 1))
    if rows:
        Image.fromarray(np.concatenate(rows, 0)).save(os.path.join(out, f"wing_{job}.png"))
