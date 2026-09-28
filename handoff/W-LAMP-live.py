"""W-LAMP：飞行中频闪帧（W-LAMP-ab.mjs 的 live 模式，页内每个 rAF readPixels）的统计。
用法：python handoff/W-LAMP-live.py <job 目录> <w>x<h> old,new [--thr 6]
每一帧：显示亮度（Rec.709）与 3×3 中位数之差 > thr 的孤立亮点 / 暗点数、横纵平均相邻差（compare.mjs 口径）、
亮度 ≥ 250 的最大 8 连通块（亮度口径死白）；输出各变体的逐帧中位数 / 最大值。帧数不等（飞机在飞，两段不是同一时刻），只比统计量。
"""
import sys, os
import numpy as np
from numpy.lib.stride_tricks import sliding_window_view
sys.stdout.reconfigure(encoding="utf-8")
job, wh, vs = sys.argv[1], sys.argv[2], sys.argv[3].split(",")
thr = float(sys.argv[sys.argv.index("--thr") + 1]) if "--thr" in sys.argv else 6.0
w, h = map(int, wh.split("x"))


def maxblob(b):
    lab = np.zeros(b.shape, np.int32); best = 0; cur = 0
    for y0, x0 in zip(*np.nonzero(b)):
        if lab[y0, x0]:
            continue
        cur += 1; st = [(y0, x0)]; lab[y0, x0] = cur; n = 0
        while st:
            y, x = st.pop(); n += 1
            for dy in (-1, 0, 1):
                for dx in (-1, 0, 1):
                    yy, xx = y + dy, x + dx
                    if 0 <= yy < b.shape[0] and 0 <= xx < b.shape[1] and b[yy, xx] and not lab[yy, xx]:
                        lab[yy, xx] = cur; st.append((yy, xx))
        best = max(best, n)
    return best


if "--all" in sys.argv:
    # 全部帧模式（live.all = true 录的，W-LAMP 审查口径）：只取连续三帧都是频闪灭的帧，每像素时间二阶差
    # |L_t − (L_{t−1}+L_{t+1})/2|（平滑运动 ≈ 0，闪烁 / 爬动的点大）；「闪烁像素」= 二阶差 > 16 级的帧占比 > 5% 的像素。
    # 分区（相对 680,400,200,90 裁剪，night-city-low）：小翼前缘斜线、后缘弯折线、灯芯附近
    import json
    regions = {"小翼前缘斜线": (0, 0, 75, 50), "后缘弯折线": (60, 40, 180, 75), "灯芯附近": (0, 45, 50, 75)}
    for v in vs:
        raw = np.fromfile(os.path.join(job, f"live_{v}_{w}x{h}.u8"), np.uint8).reshape(-1, h, w, 4)[..., :3].astype(np.float64)
        L = raw @ np.array([0.2126, 0.7152, 0.0722])
        fl = json.load(open(os.path.join(job, f"live_{v}_flags.json")))
        st = np.array(fl["strobe"]) >= 0.5
        idx = [i for i in range(1, len(L) - 1) if not (st[i - 1] or st[i] or st[i + 1])]
        d2 = np.stack([np.abs(L[i] - 0.5 * (L[i - 1] + L[i + 1])) for i in idx])
        m = (d2 > 16).mean(0) > 0.05
        parts = [f"{nm} 闪烁像素 {int(m[y0:y1, x0:x1].sum())} / 每帧>16 {float((d2[:, y0:y1, x0:x1] > 16).sum((1, 2)).mean()):.1f}" for nm, (x0, y0, x1, y1) in regions.items()]
        print(v, f"帧 {len(L)}（灭三连 {len(idx)}，帧间隔中位 {np.median(np.diff(fl['t'])):.1f} ms）", "；".join(parts))
    sys.exit(0)

for v in vs:
    raw = np.fromfile(os.path.join(job, f"live_{v}_{w}x{h}.u8"), np.uint8)
    fr = raw.reshape(-1, h, w, 4)[..., :3].astype(np.float64)
    rows = []
    for f in fr:
        L = f @ np.array([0.2126, 0.7152, 0.0722])
        med = np.median(sliding_window_view(np.pad(L, 1, mode="edge"), (3, 3)), axis=(2, 3))
        d = L - med
        adj = (np.abs(np.diff(L, axis=1)).mean() + np.abs(np.diff(L, axis=0)).mean()) / 2
        rows.append(((d > thr).sum(), (d < -thr).sum(), adj, maxblob(L >= 250)))
    a = np.array(rows, np.float64)
    print(v, "帧", len(a), "亮点 中位/最大 %.0f/%.0f" % (np.median(a[:, 0]), a[:, 0].max()), "暗点 %.0f/%.0f" % (np.median(a[:, 1]), a[:, 1].max()),
          "相邻差 %.2f/%.2f" % (np.median(a[:, 2]), a[:, 2].max()), "死白最大块 %.0f/%.0f" % (np.median(a[:, 3]), a[:, 3].max()))
