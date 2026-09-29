# PUB-5：对 flicker 存下的连拍帧（f00.png …）按多个裁剪区分别算爬行指标（与 dev-browser.mjs analyzeFlicker 的 T43 法同口径：
# 亮像素（时间均值 > 12）上 |I(t+1) − 2I(t) + I(t−1)| 的均值之和 ÷ 亮度均值之和），一次跑出整流罩区与主翼后缘区两个数。
# 用法：python PUB-5-crawl.py <帧目录> 名称=x,y,w,h [名称=x,y,w,h ...]
import sys, glob, os
import numpy as np
from PIL import Image

sys.stdout.reconfigure(encoding="utf-8")
d = sys.argv[1]
files = sorted(glob.glob(os.path.join(d, "f*.png")))
L = np.stack([np.asarray(Image.open(f).convert("RGB"), dtype=np.float64) @ np.array([0.2126, 0.7152, 0.0722]) for f in files])
T = L.shape[0]
out = []
for spec in sys.argv[2:]:
    name, box = spec.split("=")
    x, y, w, h = map(int, box.split(","))
    A = L[:, y:y + h, x:x + w]
    m = A.mean(0)
    br = m > 12
    d2 = np.abs(A[2:] - 2 * A[1:-1] + A[:-2]).sum(0) / max(1, T - 2)
    d1 = np.abs(A[1:] - A[:-1]).sum(0) / max(1, T - 1)
    crawl = d2[br].sum() / m[br].sum()
    c1 = d1[br].sum() / m[br].sum()
    out.append(f"{name}: 爬行 {crawl:.5f}  一阶 {c1:.5f}  亮像素 {int(br.sum())}")
print(f"{d}（{T} 帧）")
print("\n".join("  " + s for s in out))

# 可选：环境变量 CRAWL_HEAT=输出.png 时，把第一个裁剪区的逐像素二阶差分（×8 放大、最近邻 ×4）存成灰度热图，看爬行集中在哪
heat = os.environ.get("CRAWL_HEAT")
if heat:
    name, box = sys.argv[2].split("=")
    x, y, w, h = map(int, box.split(","))
    A = L[:, y:y + h, x:x + w]
    d2 = np.abs(A[2:] - 2 * A[1:-1] + A[:-2]).mean(0)
    im = Image.fromarray(np.clip(d2 * 8, 0, 255).astype(np.uint8)).resize((w * 4, h * 4), Image.NEAREST)
    im.save(heat)
    print("热图", heat, "最大", round(float(d2.max()), 2))
