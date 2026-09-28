# 阴影缝：按真值把近处浓云像素分成「暗 30%」「亮 70%」，看各变体在暗处的亮度比、暗处内部的逐像素离散（撒点）
import sys, json, os
import numpy as np
sys.stdout.reconfigure(encoding="utf-8")
root, jobs, vns = sys.argv[1], sys.argv[2].split(","), sys.argv[3].split(",")
def load(job, vn):
    m = json.load(open(os.path.join(root, job, vn + ".cloud.json")))
    return np.fromfile(os.path.join(root, job, vn + ".cloud.f32"), dtype=np.float32).reshape(m["H"], m["W"], 2)[::-1]
for job in jobs:
    d = load(job, "dist"); r = load(job, "ref")
    km = d[..., 1] / np.maximum(d[..., 0], 1e-4)
    for a, b in ((0, 30), (30, 60), (60, 90)):
        s = (r[..., 0] > 0.9) & (km >= a) & (km < b)
        if s.sum() < 500: continue
        yr = r[..., 1][s]
        th = np.percentile(yr, 30)
        dark = yr <= th
        print(f"== {job} {a}–{b} km  像素 {s.sum()}")
        for v in vns + ["ref"]:
            y = load(job, v)[..., 1][s]
            ratio = y[dark].mean() / yr[dark].mean()
            # 暗处的「撒点」：与真值之比的逐像素离散（对数）
            spread = np.std(np.log(np.maximum(y[dark], 1e-3) / np.maximum(yr[dark], 1e-3)))
            con = y[dark].mean() / y[~dark].mean()
            print(f"  {v:8s} 暗处/真值 {ratio:.3f}  暗处对真值对数离散 {spread:.3f}  暗/亮对比 {con:.3f}")
