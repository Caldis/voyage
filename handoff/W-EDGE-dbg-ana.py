"""wedge3：读 mkdbg 的浮点 dump，列出边缘带里各像素的探测内部量与参考覆盖率。"""
import base64
import json
import sys

import numpy as np

sys.stdout.reconfigure(encoding="utf-8")
d = json.load(open(sys.argv[1], encoding="utf-8"))["jsOut"]
CX, CY, CW, CH = d["crop"]


def f(k):
    return np.frombuffer(base64.b64decode(d[k]), np.float32).reshape(CH, CW, 4)


R, C, A, B = f("covRef")[..., 0], f("covNew")[..., 0], f("dbgA"), f("dbgB")
E = ((R > 0) & (R < 1)) | ((C > 0) & (C < 1))
ana = E & (A[..., 0] > -4) & (A[..., 0] > -8)
fold = E & (A[..., 0] == -5)
print("边缘带", int(E.sum()), "解析（探测）", int(ana.sum()), "折角", int(fold.sum()))
print("解析像素：参考覆盖率 / 新覆盖率 / sEdge / sumD px / ndv / 左差比 / 右差比 / n.x px / 几何估计 px / part")
idx = np.argwhere(ana)
for (y, x) in idx[:: max(1, len(idx) // 40)]:
    a, b = A[y, x], B[y, x]
    print(f"({x + CX},{y + CY}) ref {R[y, x]:.2f} new {C[y, x]:.2f}  sE {a[0]:+.3f} min {a[1]:+.3f} ndv {a[2]:.3f} L {a[3]:.2f} R {b[0]:.2f} nx {b[1]:.2f} geo {b[2]:+.3f} part {b[3]:.0f}")
print("折角像素：参考 / 新 / min px / 最大差比 / part")
idx = np.argwhere(fold)
for (y, x) in idx[:: max(1, len(idx) // 15)]:
    a = A[y, x]
    print(f"({x + CX},{y + CY}) ref {R[y, x]:.2f} new {C[y, x]:.2f} min {a[1]:+.3f} 差比 {a[2]:.2f} part {a[3]:.0f}")
# 统计：解析像素的误差与 ndv、左右差比的关系
e = (C - R)[ana]
for lo, hi in ((0, 0.1), (0.1, 0.2), (0.2, 0.4), (0.4, 0.7), (0.7, 1.01)):
    m = (A[..., 2][ana] >= lo) & (A[..., 2][ana] < hi)
    if m.any():
        print(f"ndv {lo}-{hi}: {int(m.sum())} 像素，误差 {e[m].mean():+.3f}")
