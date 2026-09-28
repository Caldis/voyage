"""wedge3：按路径统计覆盖率误差（对参考），可限制在裁剪区。
python pathana.py <job 目录> [x,y,w,h] [放大图输出 倍数]"""
import base64
import json
import sys

import numpy as np
from PIL import Image

sys.stdout.reconfigure(encoding="utf-8")
jd = sys.argv[1]
d = json.load(open(jd + "/dump.json", encoding="utf-8"))["jsOut"]
w, h = d["w"], d["h"]
crop = [int(v) for v in sys.argv[2].split(",")] if len(sys.argv) > 2 else [0, 0, w, h]
x, y, cw, ch = crop


def dec(k):
    return np.frombuffer(base64.b64decode(d[k]), np.uint8).reshape(h, w).astype(np.float64)[y:y + ch, x:x + cw] / 255.0


R = dec("covRef")
C = dec("covNew")
CP = dec("covPath")
P = np.round(dec("path_covPath") * 16).astype(int)
E = (R > 0) & (R < 1) | (C > 0) & (C < 1)
names = {0: "无（打中 / 没打中且远）", 1: "外侧解析", 2: "探测→解析", 3: "探测→折角/未见底→超采样", 4: "探测→早判全在里面", 5: "延续打到别的部件→超采样", 6: "探测未结束（循环用完？）", 7: "探测→估计全在里面", 9: "打中但擦过别处（grazed）不探测", 10: "打中、曲率判远、不探测不超采样", 11: "打中、不探测（其他：EdgeAA/调试位）", 12: "打中、曲率判远但 w.edge"}
print("covPath 与 covNew 一致：", float(np.abs(CP - C).max()))
for p in range(16):
    m = E & (P == p)
    if not m.any():
        continue
    e = C[m] - R[m]
    print(f"{p} {names[p]}: {int(m.sum())} 像素，误差均值 {e.mean():+.3f}，|误差| {np.abs(e).mean():.3f}，>0.25 {int((np.abs(e) > 0.25).sum())}")
if "ndv_covPath" in d:
    N = dec("ndv_covPath")
    S = dec("sil_covPath") * 20
    hit = np.isin(P, [9, 10, 11, 12])
    bins = [0, 0.12, 0.2, 0.3, 0.4, 0.5, 0.7, 1.01]
    for lab, m in (("边缘带 code10", E & (P == 10)), ("边缘带外 code10（内部）", ~E & (P == 10))):
        hh = np.histogram(N[m], bins)[0]
        print(lab, int(m.sum()), "n·v 分档", list(zip(bins[:-1], hh.tolist())))
    m = E & (P == 10)
    if m.any():
        print("边缘带 code10 的 silPx 分位", np.percentile(S[m], [10, 50, 90]).round(2).tolist())
if len(sys.argv) > 4:
    s = int(sys.argv[4])
    pal = np.array([[0, 0, 0], [0, 0.6, 1], [0, 1, 0], [1, 0, 1], [1, 1, 0], [1, 0.5, 0], [1, 0, 0], [1, 1, 1], [0,0,0], [0.5,0.5,1], [1,0.3,0.3], [0.6,0.6,0.6], [0.3,1,1], [0,0,0],[0,0,0],[0,0,0]])
    col = pal[P] * (0.35 + 0.65 * np.maximum(C, R)[..., None])
    err = C - R
    ei = np.stack([np.clip(err * 2, 0, 1), np.zeros_like(err), np.clip(-err * 2, 0, 1)], -1)
    im = np.concatenate([col, np.full((ch, 2, 3), 0.5), ei], 1)
    Image.fromarray((im * 255).astype(np.uint8)).resize((im.shape[1] * s, im.shape[0] * s), Image.NEAREST).save(sys.argv[3])
