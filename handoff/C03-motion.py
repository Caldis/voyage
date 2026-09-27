# C03-motion.mjs 的分析：逐帧（小块）亮度序列里去掉慢变的运动趋势，看 1–4 Hz 的「呼吸」
#   按 24×24 块求每帧亮度，块序列减去 7 帧滑动平均（运动带来的慢变），剩下的是逐帧波动；
#   再用帧时间戳做 Lomb 式的简单 DFT，报告 1–4 Hz 频段的功率占 0.5 Hz 以上总功率的比例
# 用法：python C03-motion.py <目录>
import sys, os, json, glob
import numpy as np
from PIL import Image
sys.stdout.reconfigure(encoding="utf-8")
d = sys.argv[1]
times = json.load(open(os.path.join(d, "times.json")))
for vn, ts in times.items():
    files = sorted(glob.glob(os.path.join(d, vn + "-*.png")))
    fr = np.stack([np.asarray(Image.open(f).convert("RGB")).astype(np.float64) @ [0.2126, 0.7152, 0.0722] for f in files])
    n, h, w = fr.shape
    B = 24
    blocks = fr[:, : h // B * B, : w // B * B].reshape(n, h // B, B, w // B, B).mean(axis=(2, 4)).reshape(n, -1)
    k = 7
    ker = np.ones(k) / k
    trend = np.stack([np.convolve(blocks[:, j], ker, "same") for j in range(blocks.shape[1])], 1)
    resid = (blocks - trend)[k:-k]
    t = (np.array(ts[: n]) - ts[0]) / 1000.0
    tt = t[k:-k]
    fs = np.linspace(0.5, 0.5 / max(np.median(np.diff(t)), 1e-3), 60)
    P = np.array([np.abs((resid * np.exp(-2j * np.pi * f * tt)[:, None]).sum(0)) ** 2 for f in fs]).sum(1)
    band = P[(fs >= 1) & (fs <= 4)].sum() / P.sum()
    print(f"{vn:6s} 帧 {n}  平均帧间隔 {np.median(np.diff(t)) * 1000:.0f} ms  去趋势块波动 std {resid.std():.3f}  1–4 Hz 占比 {band:.3f}")
