# C-TOFU 指标：从 dev-browser ab 的输出目录（每个 job 一个子目录）算形状指标
# 用法：python ctofu_metrics.py <ab 输出目录> [变体前缀 old,new] [--band 20,150]
#  - 截图（显示像素，PNG）：裁剪区（job.crop）里的方向性高频
#      ribX  = E|∂x box_y7(L)| / E|∂x L|：横向梯度沿竖直方向的相干度（竖向肋纹 / 竖壁 → 高；随机噪声 ≈ 1/√7 ≈ 0.38）
#      ribY  = E|∂y box_x7(L)| / E|∂y L|：对照（水平的云底 / 地平线层次，本来就高）
#      hfX   = E|∂x L|（亮度 0–255 的横向相邻差），hfY 同理
#  - cloudDump（α = 1 − T 的 16 帧平均；<v>-alt 变体的 Y/α = 云的加权高度 km；<v>-dist 的 Y/α = 深度 km）
#      wall3 = 轮廓（0.3 < α < 0.7 且 |∇α| 够大）里「法向接近水平（|gx| > 2.75|gy|，±20°）且上下相邻也是」的比例：竖壁
#      topIQR / topP90-10 = 轮廓顶边（α>0.5、上方 α<0.5）的云高度分位差，km：云顶高低错落程度
#      topMed = 顶边高度中位（km）
#      各指标只统计 --band 距离带（km，按 dist 变体）内的像素
import sys, os, json
import numpy as np
from PIL import Image

sys.stdout.reconfigure(encoding="utf-8")


def load_dump(d, name):
    p = os.path.join(d, name + ".cloud.f32")
    if not os.path.exists(p):
        return None
    meta = json.load(open(os.path.join(d, name + ".cloud.json"), encoding="utf-8"))
    W, H = meta["W"], meta["H"]
    a = np.fromfile(p, dtype=np.float32).reshape(H, W, 2)[::-1]  # 行自下而上 → 翻成自上而下
    return a[..., 0].copy(), a[..., 1].copy()


def box(a, n, axis):
    a = np.moveaxis(a, axis, 0)
    c = np.cumsum(np.concatenate([np.zeros((1,) + a.shape[1:]), a], axis=0), axis=0)
    h = n // 2
    out = np.empty_like(a)
    N = a.shape[0]
    for i in range(N):
        lo, hi = max(0, i - h), min(N, i + h + 1)
        out[i] = (c[hi] - c[lo]) / (hi - lo)
    return np.moveaxis(out, 0, axis)


def screen_metrics(png, crop):
    im = np.asarray(Image.open(png).convert("RGB")).astype(np.float64)
    L = im @ np.array([0.2126, 0.7152, 0.0722])
    if crop:
        x, y, w, h = crop
        L = L[y:y + h, x:x + w]
    gx = np.abs(np.diff(L, axis=1))
    gy = np.abs(np.diff(L, axis=0))
    Ly = box(L, 7, 0)
    Lx = box(L, 7, 1)
    gxy = np.abs(np.diff(Ly, axis=1))[3:-3]
    gyx = np.abs(np.diff(Lx, axis=0))[:, 3:-3]
    return {
        "hfX": gx.mean(), "hfY": gy.mean(),
        "ribX": gxy.mean() / max(gx[3:-3].mean(), 1e-9),
        "ribY": gyx.mean() / max(gy[:, 3:-3].mean(), 1e-9),
    }


def shape_metrics(A, Z, D, band, cropFrac):
    H, W = A.shape
    if cropFrac:
        x0, y0, x1, y1 = cropFrac
        sl = (slice(int(y0 * H), int(y1 * H)), slice(int(x0 * W), int(x1 * W)))
        A = A[sl]
        Z = Z[sl] if Z is not None else None
        D = D[sl] if D is not None else None
    gx = np.zeros_like(A); gy = np.zeros_like(A)
    gx[:, 1:-1] = (A[:, 2:] - A[:, :-2]) * 0.5
    gy[1:-1, :] = (A[2:, :] - A[:-2, :]) * 0.5
    g = np.hypot(gx, gy)
    inband = np.ones_like(A, dtype=bool)
    if D is not None and band:
        inband = (D > band[0]) & (D < band[1])
    edge = (A > 0.3) & (A < 0.7) & (g > 0.04) & inband
    wall = edge & (np.abs(gx) > 2.75 * np.abs(gy))
    wall3 = wall.copy()
    wall3[1:-1] = wall[1:-1] & wall[:-2] & wall[2:]
    wall3[0] = False; wall3[-1] = False
    out = {"edgeN": int(edge.sum()), "wall": wall.sum() / max(edge.sum(), 1), "wall3": wall3.sum() / max(edge.sum(), 1)}
    if Z is not None:
        top = np.zeros_like(A, dtype=bool)
        top[1:] = (A[1:] > 0.5) & (A[:-1] < 0.5)
        top &= inband
        z = Z[top]
        z = z[np.isfinite(z)]
        if z.size > 20:
            p = np.percentile(z, [10, 25, 50, 75, 90])
            out.update({"topN": int(z.size), "topMed": p[2], "topIQR": p[3] - p[1], "topP90_10": p[4] - p[0]})
    if D is not None:
        # 按距离分带的竖向相干度（云缓冲 α，全分辨率）：ribA = E|∂x box_y7 α| / E|∂x α|，只统计该带内、∂x 有意义的像素
        gxa = np.abs(np.diff(A, axis=1))
        gxb = np.abs(np.diff(box(A, 7, 0), axis=1))
        Dm = D[:, :-1]
        for nm, lo, hi in (("rib20_100", 20, 100), ("rib100_", 100, 1e9)):
            sel = (Dm > lo) & (Dm < hi) & (gxa > 0.02)
            sel[:4] = False; sel[-4:] = False
            out[nm] = float(gxb[sel].sum() / max(gxa[sel].sum(), 1e-9)) if sel.sum() > 50 else float("nan")
            out["n" + nm] = int(sel.sum())
    # 游程指标：竖壁 = 侧边像素（α 过 0.5、左右相邻跨过 0.5）在同一列上连续 ≥ 5 行；平顶 = 顶边像素（α 过 0.5、上下跨过）在同一行上连续 ≥ 12 列
    B = A > 0.5
    side = np.zeros_like(B); side[:, 1:] = B[:, 1:] != B[:, :-1]
    topE = np.zeros_like(B); topE[1:] = B[1:] & ~B[:-1]
    def runs(mask, axis, n):
        m = np.moveaxis(mask, axis, 0).astype(np.int32)
        run = np.zeros_like(m); cnt = np.zeros(m.shape[1:], np.int32)
        # 前向游程长度
        for i in range(m.shape[0]):
            cnt = (cnt + 1) * m[i]; run[i] = cnt
        # 反向传播最大值，得到每个像素所在游程的长度
        best = np.zeros(m.shape[1:], np.int32)
        L = np.zeros_like(m)
        for i in range(m.shape[0] - 1, -1, -1):
            best = np.where(m[i] > 0, np.maximum(best, run[i]), 0); L[i] = best
        return np.moveaxis(L >= n, 0, axis)
    if D is not None:
        for nm, lo, hi in (("20_100", 20, 100), ("100_", 100, 1e9)):
            sel = (D > lo) & (D < hi)
            s = side & sel; t = topE & sel
            out["wallRun" + nm] = float((runs(side, 0, 5) & s).sum() / max(s.sum(), 1))
            out["flatRun" + nm] = float((runs(topE, 1, 12) & t).sum() / max(t.sum(), 1))
    out["cover"] =float((A > 0.5)[inband].mean()) if inband.any() else 0.0
    return out


def main():
    root = sys.argv[1]
    band = [20, 150]
    names = ["old", "new"]
    for a in sys.argv[2:]:
        if a.startswith("--band="):
            band = [float(x) for x in a[7:].split(",")]
        elif not a.startswith("--"):
            names = a.split(",")
    summ = json.load(open(os.path.join(root, "summary.json"), encoding="utf-8"))
    for job in summ:
        jd = os.path.join(root, job["job"])
        crop = job.get("crop")
        print(f"== {job['job']}  crop={crop}  band={band} km")
        rows = []
        for n in names:
            r = {"v": n}
            png = os.path.join(jd, n + ".png")
            if os.path.exists(png):
                r.update(screen_metrics(png, crop))
            dA = load_dump(jd, n)
            dZ = load_dump(jd, n + "-alt")
            dD = load_dump(jd, n + "-dist")
            if dA is not None:
                A = dA[0]
                Z = dZ[1] / np.maximum(dZ[0], 1e-4) if dZ is not None else None
                D = dD[1] / np.maximum(dD[0], 1e-4) if dD is not None else None
                cf = None
                if crop:
                    # 截图是 1600×1200 显示像素；云缓冲按比例对应
                    x, y, w, h = crop
                    cf = (x / 1600, y / 1200, (x + w) / 1600, (y + h) / 1200)
                r.update(shape_metrics(A, Z, D, band, cf))
                ref = load_dump(jd, n + "-ref")
                if ref is not None:
                    m = A > 0.02
                    if cf:
                        H, W = A.shape
                        mm = np.zeros_like(m); mm[int(cf[1] * H):int(cf[3] * H), int(cf[0] * W):int(cf[2] * W)] = True
                        m &= mm
                    r["dAlphaRef"] = float(np.abs(A - ref[0])[m].mean()) if m.any() else float("nan")
                    if D is not None:
                        for nm, sel in (("dA_near", D < 20), ("dA_far", D >= 20)):
                            mm = m & sel
                            r[nm] = float(np.abs(A - ref[0])[mm].mean()) if mm.sum() > 50 else float("nan")
            rows.append(r)
        keys = []
        for r in rows:
            for k in r:
                if k not in keys:
                    keys.append(k)
        print("\t".join(keys))
        for r in rows:
            print("\t".join((f"{r[k]:.4g}" if isinstance(r.get(k), float) else str(r.get(k, ""))) for k in keys))


main()
