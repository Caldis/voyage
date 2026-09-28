"""C10：斜纹指数只在「噪声分量」上算（单帧 − 16 帧平均），排除真实结构（C12 的斜纹指数按残差方差归一，
噪声变少时真实结构占比上升，指数会假性升高）。用法：python C10-nstreak.py <目录> 变体1 变体2 ..."""
import os, sys
import numpy as np
from PIL import Image
sys.stdout.reconfigure(encoding="utf-8")
root, vns = sys.argv[1], sys.argv[2:]
SH = [(0, 1), (1, 0), (1, 1), (1, -1), (1, 2), (2, 1), (1, -2), (2, -1), (2, 2), (2, -2)]
res = {}
for job in sorted(os.listdir(root)):
    if not os.path.isdir(os.path.join(root, job)):
        continue
    line = []
    for vn in vns:
        d = os.path.join(root, job, vn)
        if not os.path.isdir(d):
            continue
        fs = sorted(f for f in os.listdir(d) if f.startswith("f") and f[1:3].isdigit() and f.endswith(".png"))
        S = np.stack([np.asarray(Image.open(os.path.join(d, f)).convert("RGB")).astype(np.float64) @ [0.2126, 0.7152, 0.0722] for f in fs])
        N = S - S.mean(0)
        st, amp = [], []
        for H in N:
            H = H[3:-3, 3:-3] - H.mean()
            v0 = (H * H).mean()
            st.append(max((H * np.roll(np.roll(H, dy, 0), dx, 1))[3:-3, 3:-3].mean() / v0 for dy, dx in SH))
            amp.append(np.sqrt(v0))
        res.setdefault(vn, []).append((np.mean(st), np.mean(amp)))
        line.append(f"{vn} 斜纹 {np.mean(st):+.3f} 幅度 {np.mean(amp):.2f}")
    print(f"{job:15s} " + " | ".join(line))
b = vns[0]
for vn in vns[1:]:
    r = [x[1] / y[1] for x, y in zip(res[vn], res[b])]
    print(f"{vn} 噪声幅度 ×{np.exp(np.mean(np.log(r))):.3f}（最差 ×{max(r):.3f}），斜纹指数均值 {np.mean([x[0] for x in res[vn]]):+.3f} 对 {np.mean([x[0] for x in res[b]]):+.3f}")
