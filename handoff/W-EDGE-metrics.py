"""W-EDGE：读 `dev-browser.mjs ab`（W-EDGE-mkjobs.py 生成的 jobs）的输出，按参考图算外轮廓指标。

- 边缘带 E：参考图里「25 条子射线不全打中同一部件、或覆盖率 < 1、或深度跨度大」的像素（covRef 的 g 通道）再膨胀 1 像素。
- 差和：各变体与参考图（ref.png，显示值 0–255，三通道取最大）在 E 上的绝对差之和、差 > 8 的像素数。
- hf2：E 上「亮度 − 3×3 盒滤波」的平均绝对值（台阶越硬越大；参考图本身的 hf2 是「正确的锐度」）。
- 外扩 / 内缩：覆盖率 > 0 而参考图覆盖率 = 0 的像素（按离参考图机翼的距离分档）、反之。
- 非机翼逐位：dump 在页面里按覆盖率（old、new 都为 0）比过 HDR，直接照抄。
用法：python handoff/W-EDGE-metrics.py <ab 输出目录> [变体1,变体2,...] [--crop job=x,y,w,h ...] [--zoom job=x,y,w,h,倍数 输出目录]
"""
import base64
import json
import os
import sys

import numpy as np
from PIL import Image

sys.stdout.reconfigure(encoding="utf-8")


def load(p):
    return np.asarray(Image.open(p).convert("RGB")).astype(np.float64)


def lum(a):
    return a @ np.array([0.2126, 0.7152, 0.0722])


def box3(L):
    P = np.pad(L, 1, mode="edge")
    s = sum(P[1 + dy:1 + dy + L.shape[0], 1 + dx:1 + dx + L.shape[1]] for dy in (-1, 0, 1) for dx in (-1, 0, 1))
    return s / 9.0


def dilate(M, r=1):
    P = np.pad(M, r)
    out = np.zeros_like(M)
    for dy in range(-r, r + 1):
        for dx in range(-r, r + 1):
            out |= P[r + dy:r + dy + M.shape[0], r + dx:r + dx + M.shape[1]]
    return out


def dist_to(M, maxr=4):
    """每个像素到 M 为真的像素的切比雪夫距离（> maxr 记 maxr+1）"""
    d = np.full(M.shape, maxr + 1, np.int32)
    cur = M.copy()
    d[cur] = 0
    for r in range(1, maxr + 1):
        nxt = dilate(cur, 1)
        d[nxt & ~cur] = r
        cur = nxt
    return d


def dec(s, w, h):
    return np.frombuffer(base64.b64decode(s), np.uint8).reshape(h, w)[::-1].astype(np.float64) / 255.0


def main():
    root = sys.argv[1]
    args = sys.argv[2:]
    vs = None
    crops = {}
    zooms = {}
    zoom_out = None
    i = 0
    while i < len(args):
        a = args[i]
        if a == "--crop":
            j, c = args[i + 1].split("=")
            crops[j] = [int(x) for x in c.split(",")]
            i += 2
        elif a == "--zoom":
            j, c = args[i + 1].split("=")
            zooms.setdefault(j, []).append([int(x) for x in c.split(",")])
            zoom_out = args[i + 2]
            i += 3
        else:
            vs = a.split(",")
            i += 1
    jobs = [d for d in sorted(os.listdir(root)) if os.path.isfile(os.path.join(root, d, "dump.json"))]
    tot = {}
    for j in jobs:
        jd = os.path.join(root, j)
        dump = json.load(open(os.path.join(jd, "dump.json"), encoding="utf-8"))["jsOut"]
        w, h = dump["w"], dump["h"]
        cov = {k: dec(dump[k], w, h) for k in dump if k.startswith("cov")}
        mixed = dec(dump["mixed"], w, h) > 0.5
        E = dilate(mixed, 1)
        R = load(os.path.join(jd, "ref.png"))
        names = vs or [f[:-4] for f in sorted(os.listdir(jd)) if f.endswith(".png") and not f.startswith(("cov", "dump", "ref")) and "_r" not in f and ".z" not in f]
        LR = lum(R)
        hfR = np.abs(LR - box3(LR))[E].mean()
        rows = []
        for v in names:
            p = os.path.join(jd, v + ".png")
            if not os.path.exists(p):
                continue
            A = load(p)
            D = np.abs(A - R).max(2)
            LA = lum(A)
            hf = np.abs(LA - box3(LA))[E].mean()
            row = {"v": v, "sumE": D[E].sum(), "over8E": int((D[E] > 8).sum()), "hf2E": hf}
            if j in crops:
                x, y, cw, ch = crops[j]
                sl = (slice(y, y + ch), slice(x, x + cw))
                Ec = E[sl]
                row["sumC"] = D[sl][Ec].sum()
                row["hf2C"] = np.abs(LA - box3(LA))[sl][Ec].mean()
                row["hf2Cref"] = np.abs(LR - box3(LR))[sl][Ec].mean()
            rows.append(row)
            t = tot.setdefault(v, {"sumE": 0.0, "over8E": 0, "logSum": 0.0, "n": 0})
            t["sumE"] += row["sumE"]
            t["over8E"] += row["over8E"]
            t["logSum"] += np.log(max(row["sumE"], 1.0))
            t["n"] += 1
        print(f"== {j}：边缘带 {int(E.sum())} 像素，参考 hf2E {hfR:.3f}")
        for r in rows:
            extra = f"  裁剪 差和 {r['sumC']:.0f} hf2 {r['hf2C']:.3f}（参考 {r['hf2Cref']:.3f}）" if "sumC" in r else ""
            print(f"  {r['v']:>10}: 差和E {r['sumE']:9.0f}  >8 {r['over8E']:6d}  hf2E {r['hf2E']:.3f}{extra}")
        # 覆盖率：外扩 / 内缩（相对参考图）
        cr = cov.get("covRef")
        if cr is not None:
            refW = cr > 0
            dref = dist_to(refW, 3)
            for k in [k for k in cov if k not in ("covRef", "covDbg")]:
                if k not in cov:
                    continue
                c = cov[k]
                grow = (c > 0) & ~refW
                shrink = (c <= 0) & refW
                hist = [int((grow & (dref == r)).sum()) for r in (1, 2, 3, 4)]
                # 覆盖率误差（只在边缘带里）
                ce = np.abs(c - cr)[E]
                print(f"  {k}: 外扩 {int(grow.sum())}（离参考机翼 1/2/3/≥4 像素：{hist}），内缩 {int(shrink.sum())}；边缘带覆盖率平均误差 {ce.mean():.4f}，>0.25 的 {int((ce > 0.25).sum())}")
        nw = dump.get("nonwing", {})
        for k, r in nw.items():
            print(f"  非机翼（old、{k} 覆盖率都为 0）{r['px']} 像素中 HDR 不同 {r['diffPx']}（最大 {r['max']:.3g}）；新长出覆盖 {r['grow']}，消失 {r['shrink']}")
        if zoom_out and j in zooms:
            os.makedirs(zoom_out, exist_ok=True)
            for zi, (x, y, cw, ch, s) in enumerate(zooms[j]):
                tiles = []
                for v in (names + ["ref"]):
                    p = os.path.join(jd, v + ".png")
                    if os.path.exists(p):
                        im = Image.open(p).convert("RGB").crop((x, y, x + cw, y + ch)).resize((cw * s, ch * s), Image.NEAREST)
                        tiles.append(im)
                # 最后一格：new 与参考之差 ×4
                pn, pr = os.path.join(jd, "new.png"), os.path.join(jd, "ref.png")
                if os.path.exists(pn) and os.path.exists(pr):
                    dd = np.clip(np.abs(load(pn) - load(pr))[y:y + ch, x:x + cw] * 4, 0, 255).astype(np.uint8)
                    tiles.append(Image.fromarray(dd).resize((cw * s, ch * s), Image.NEAREST))
                W =sum(t.width for t in tiles) + 4 * (len(tiles) - 1)
                canvas = Image.new("RGB", (W, ch * s), (255, 0, 255))
                xx = 0
                for t in tiles:
                    canvas.paste(t, (xx, 0))
                    xx += t.width + 4
                canvas.save(os.path.join(zoom_out, f"{j}-z{zi}.png"))
    print("== 合计（各 job 差和E 之和 / 几何均值 / >8）")
    for v, t in tot.items():
        print(f"  {v:>10}: {t['sumE']:.0f} / {np.exp(t['logSum'] / t['n']):.0f} / {t['over8E']}")


main()
