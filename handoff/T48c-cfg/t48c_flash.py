# 闪电：被照亮的区域（flash 变体比 noFlash 亮 > 20 级）里，各变体相对「不做局部适应」参考的压暗
# python t48c_flash.py <目录> <场景> <无闪参考> <不做局部适应参考> <变体,...>
import sys, os
import numpy as np
from PIL import Image
sys.stdout.reconfigure(encoding="utf-8")
W = np.array([0.2126, 0.7152, 0.0722])
d, s, nf, nl, vs = sys.argv[1:6]
L = lambda v: np.asarray(Image.open(os.path.join(d, f"{s}.{v}.png")).convert("RGB"), float) @ W
N, R = L(nf), L(nl)
lit = (R - N) > 20
print(f"被闪电照亮的像素（{nl} − {nf} > 20）：{lit.sum()}")
for v in vs.split(","):
    D = L(v) - R
    print(f"{v:9s} 相对 {nl}：照亮区 均值 {D[lit].mean():6.1f} p5 {np.percentile(D[lit], 5):6.1f} 最小 {D[lit].min():6.1f}；压暗 >8 的像素 {(D[lit] < -8).sum()}")
