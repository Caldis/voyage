# WX11g：换档瞬间有没有跳变。读 ab job.live 录下的逐帧裁剪（.u8）和逐帧记录（wind / mix），
# 先 8×8 块平均（压掉 8 Hz 的耀斑闪烁，只留海况的大尺度亮度 / 纹理），再算相邻帧的块均值差（mean |Δ|），
# 找出风速跨档（mix 从 0 跳开 / 下档变化）与风速阶跃的帧，看那一帧的差是否超出其余帧的分布。
# 用法：python apps/voyage/handoff/WX11g-live.py tmp/screenshot/WX11g/live/low-sea-glint-live
import glob
import json
import os
import sys

import numpy as np

sys.stdout.reconfigure(encoding="utf-8")
d = sys.argv[1]
B = 8
for u8 in sorted(glob.glob(os.path.join(d, "live_*_*x*.u8"))):
    base = os.path.basename(u8)[5:-3]
    name, dims = base.rsplit("_", 1)
    w, h = map(int, dims.split("x"))
    raw = np.fromfile(u8, dtype=np.uint8).reshape(-1, h, w, 4).astype(np.float32)
    lum = 0.2126 * raw[..., 0] + 0.7152 * raw[..., 1] + 0.0722 * raw[..., 2]
    n = lum.shape[0]
    hb, wb = h // B, w // B
    blk = lum[:, : hb * B, : wb * B].reshape(n, hb, B, wb, B).mean(axis=(2, 4))
    diff = np.abs(np.diff(blk, axis=0)).mean(axis=(1, 2))  # diff[i] = 帧 i → i+1
    flags = json.load(open(os.path.join(d, f"live_{name}_flags.json"), encoding="utf-8"))
    wind = np.array(flags.get("wind", [np.nan] * n), dtype=float)
    ev = [i for i in range(1, n) if wind[i] != wind[i - 1] and (np.floor_divide(wind[i], 1e9) or True)]
    med = float(np.median(diff))
    p99 = float(np.percentile(diff, 99))
    top = np.argsort(diff)[::-1][:3]
    print(f"{name}: 帧 {n}，块差中位 {med:.3f}、p99 {p99:.3f}、最大 {diff.max():.3f}（帧 {int(top[0])}→{int(top[0]) + 1}，风速 {wind[top[0]]:.3f}→{wind[top[0] + 1]:.3f}）")
    # 跨过 7 m/s 档位的那一帧
    cross = [i for i in range(1, n) if (wind[i - 1] - 7) * (wind[i] - 7) < 0 or (wind[i - 1] == 7) != (wind[i] == 7)]
    for i in cross[:3]:
        lo, hi = max(0, i - 4), min(len(diff), i + 3)
        print(f"   跨 7 m/s：帧 {i - 1}→{i}（{wind[i - 1]:.3f}→{wind[i]:.3f}），块差 {diff[i - 1]:.3f}；前后几帧 {np.round(diff[lo:hi], 3).tolist()}")
    print(f"   风速范围 {np.nanmin(wind):.2f}–{np.nanmax(wind):.2f}")
