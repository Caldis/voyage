"""T43：量道路和城区灯点的亮度比（配合 T43-shots.mjs 的「正常 / _noroad（调试 25，去掉道路）」两张图，曝光冻结，二者只差道路）。
用法：python T43-stats.py 正常.png 去掉道路.png x0 y0 w h
- 亮度一律先按 sRGB 解码成线性（显示值直接平均会低估亮点）；
- 道路的贡献 = 同名 _road.png（调试 24）；道路像素 = 贡献 > 0.004（线性，约显示值 12）；
- 输出：
  地毯      去掉道路后区域的平均线性亮度（城区灯点铺开的「地毯」亮度，美术总监说的「同片城区灯点均值」）；
  路本身/毯 道路像素上道路自己的贡献（正常 − 去掉道路）÷ 地毯（目标：城区 ≤ 1.2；城外高速 0.2–0.3，以同片城区的地毯为准）；
  路像素/毯 道路像素在正常图里的平均亮度 ÷ 地毯（含路上叠着的灯点，只作参考）；
  路p90/毯；道路像素占比；道路能量占比（道路贡献 ÷ 正常图总能量）。
"""
import sys
import numpy as np
from PIL import Image


def lum(path, r):
    x0, y0, w, h = r
    a = np.asarray(Image.open(path).convert("RGB"), dtype=np.float64)[y0:y0 + h, x0:x0 + w] / 255.0
    l = np.where(a <= 0.04045, a / 12.92, ((a + 0.055) / 1.055) ** 2.4)
    return l @ np.array([0.2126, 0.7152, 0.0722])


full, noroad = sys.argv[1], sys.argv[2]
r = tuple(map(int, sys.argv[3:7]))
LA, LN = lum(full, r), lum(noroad, r)
# 道路自己的亮度直接取调试 24 的图（同一曝光；不含空气透视，夜里透射率约 0.8–0.9，略高估）。
# 不用「正常 − 去掉道路」：三张图之间头部 / 航向还会漂几个像素，灯点错位，相减全是灯点（实测）
c = lum(full.replace(".png", "_road.png"), r)
m = c > 0.004
carpet = LN.mean()
rm = LA[m].mean() if m.any() else float("nan")
p90 = np.percentile(LA[m], 90) if m.any() else float("nan")
cm = c[m].mean() if m.any() else float("nan")
cp90 = np.percentile(c[m], 90) if m.any() else float("nan")
# 分块（32 px）：「城区块」= 块内地毯 ≥ 全部块地毯 p95 的 30%，「城外块」= < 5%。
# 城区：各块「道路本身 ÷ 本块地毯」的中位；城外：各块道路本身 ÷ 城区块地毯的平均（「城外道路是城区均值的几成」）
B = 32
H, W = LN.shape
bc, br = [], []
for y in range(0, H - B + 1, B):
    for x in range(0, W - B + 1, B):
        mm = m[y:y + B, x:x + B]
        bc.append(LN[y:y + B, x:x + B].mean())
        br.append(c[y:y + B, x:x + B][mm].mean() if mm.sum() >= 4 else np.nan)
bc, br = np.array(bc), np.array(br)
p95 = np.percentile(bc, 95)
urb, rur = bc >= 0.3 * p95, bc < 0.05 * p95
uc = bc[urb].mean()
u_ratio = np.nanmedian(br[urb] / bc[urb]) if np.any(urb & ~np.isnan(br)) else float("nan")
r_ratio = np.nanmedian(br[rur]) / uc if np.any(rur & ~np.isnan(br)) else float("nan")
r_frac = np.mean(~np.isnan(br[rur])) * 100 if rur.any() else float("nan")
print(f"    分块：城区块 {urb.sum()} 个，路本身/本块地毯 中位 {u_ratio:.2f}；城外块 {rur.sum()} 个，其中有路 {r_frac:.0f}%，路本身/城区地毯 中位 {r_ratio:.2f}")
print(f"{full} {list(r)}  地毯 {carpet:.4f}  道路像素 {m.mean() * 100:.1f}%  路本身/毯 {cm / max(carpet, 1e-9):.2f}（p90 {cp90 / max(carpet, 1e-9):.2f}）  路像素/毯 {rm / max(carpet, 1e-9):.2f}  "
      f"路p90/毯 {p90 / max(carpet, 1e-9):.2f}  道路能量占比 {c.sum() / max(LA.sum(), 1e-9) * 100:.1f}%")
