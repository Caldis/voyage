# 把改前 / 改后两份 STROBE-FLASH-live.mjs 的 summary.json 拼成前后表（Markdown）
# 用法：python handoff/STROBE-FLASH-table.py <改前 summary.json> <改后 summary.json>
import json
import sys

sys.stdout.reconfigure(encoding="utf-8")
A = json.load(open(sys.argv[1], encoding="utf-8"))
B = json.load(open(sys.argv[2], encoding="utf-8"))
print("| 场景 | 整窗跳变 改前 → 改后 | 近 | 中 | 远 | 舱内 | 远区爆闪像素 | 近中变暗像素 | 非频闪闪烁像素（中远） | 适应 o 抬升（档） |")
print("|---|---|---|---|---|---|---|---|---|---|")


def two(d, f):
    vs = list(d["variants"].values())
    return " / ".join(f(v) for v in vs)


for name in A:
    if name not in B:
        continue
    a, b = A[name], B[name]
    j = lambda k: (lambda v: f"{v['jump'][k][0]:.1f}")
    row = [name]
    for k in ["整窗", "窗内近", "窗内中", "窗内远", "舱内"]:
        row.append(f"{two(a, j(k))} → {two(b, j(k))}")
    row.append(f"{two(a, lambda v: f'{v['flashFarFrac'] * 100:.0f}%')} → {two(b, lambda v: f'{v['flashFarFrac'] * 100:.0f}%')}")
    row.append(f"{two(a, lambda v: str(v['darkNearMid']))} → {two(b, lambda v: str(v['darkNearMid']))}")
    row.append(f"{two(a, lambda v: str(v['flickerNoStrobe']['中远']))} → {two(b, lambda v: str(v['flickerNoStrobe']['中远']))}")
    row.append(f"{two(a, lambda v: f'{v['adaptJumpLog2']:.2f}')} → {two(b, lambda v: f'{v['adaptJumpLog2']:.2f}')}")
    print("| " + " | ".join(row) + " |")
