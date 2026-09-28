# C-FLAT 诊断 / 验收：云缓冲读回（ab 的 cloudDump）+ 同页截图，统计曝光前的云亮度分布与显示上的映射。
# 用法：python C-FLAT-an.py <ab 输出根目录> [--vars cur,noAmb,noMS,noTail,tmOff] [--hdrvar cur] [--json out.json]
# 口径：
#   · 云自身亮度 c = Y / α（云缓冲左半 L 预乘、A = 透射；只取 α ≥ 0.9 的不透明云，不含空气透视 / 背景）。
#   · 受光 / 背光按 c 在该场景不透明云里的分位：受光 = ≥ p60，背光 = ≤ p20，云缝 = 最暗 10%。
#   · 受光 / 背光比 = 受光均值 / 背光均值；云缝比 = 最暗 10% 均值 / 中位数。
#   · 分量（有对应变体时）：amb = cur − noAmb，ms = cur − noMS，tail = cur − noTail，sun1 = 其余（单次 + 前向峰）。
#   · 显示：截图按云缓冲像素中心取 luma（Rec.709，0–255），窗内裁剪 420,120,760×1000，机翼可见的场景去掉机翼区；
#     报受光面（c ≥ p50）p10–p90 跨越的灰阶数、整片云 p10–p90 的灰阶数、每档（log2 c）对应多少级（中位斜率）。
import sys, os, json, glob
import numpy as np
from PIL import Image

sys.stdout.reconfigure(encoding="utf-8")
args = sys.argv[1:]
root = args[0]
opt = {}
i = 1
while i < len(args):
    opt[args[i].lstrip("-")] = args[i + 1]
    i += 2
VARS = opt.get("vars", "cur,noAmb,noMS,noTail,tmOff").split(",")
HDRVAR = opt.get("hdrvar", "cur")
SHOTVARS = opt.get("shotvars", "cur,tmOff").split(",")
WIN = (420, 120, 760, 1000)
# 机翼可见（wing-pos 8）的场景：机翼大致占左上三角，整块去掉
WING_EXCL = {"noon-cumulus": (380, 270, 900, 880), "sunset-wing": (380, 270, 900, 880)}


def load(jdir, v):
    f = os.path.join(jdir, f"{v}.cloud.f32")
    if not os.path.exists(f):
        return None
    meta = json.load(open(f.replace(".f32", ".json"), encoding="utf-8"))
    a = np.fromfile(f, dtype=np.float32).reshape(meta["H"], meta["W"], 2)[::-1]  # GL 底行在前 → 翻成屏幕上行在前
    return a[..., 0], a[..., 1]


def luma_png(p):
    im = np.asarray(Image.open(p).convert("RGB")).astype(np.float64)
    return 0.2126 * im[..., 0] + 0.7152 * im[..., 1] + 0.0722 * im[..., 2]


out = {}
for jdir in sorted(glob.glob(os.path.join(root, "*"))):
    if not os.path.isdir(jdir):
        continue
    job = os.path.basename(jdir)
    base = load(jdir, HDRVAR)
    if base is None:
        continue
    A, Y = base
    H, W = A.shape
    op = A >= 0.9
    c = np.where(op, Y / np.maximum(A, 1e-6), np.nan)
    # 屏幕坐标（像素中心）
    sx, sy = 1600 / W, 1200 / H
    xs = (np.arange(W) + 0.5) * sx
    ys = (np.arange(H) + 0.5) * sy
    X, Yy = np.meshgrid(xs, ys)
    inwin = (X >= WIN[0]) & (X < WIN[0] + WIN[2]) & (Yy >= WIN[1]) & (Yy < WIN[1] + WIN[3])
    if job in WING_EXCL:
        e = WING_EXCL[job]
        inwin &= ~((X >= e[0]) & (X < e[2]) & (Yy >= e[1]) & (Yy < e[3]))
    m = op & inwin & np.isfinite(c) & (c > 0)
    cv = c[m]
    if cv.size < 200:
        print(f"{job}: 不透明云像素太少（{cv.size}）"); continue
    lc = np.log2(cv)
    q = {k: float(np.percentile(cv, k)) for k in (5, 10, 20, 50, 60, 90, 95, 99)}
    lit = cv >= q[60]
    sh = cv <= q[20]
    seam = cv <= q[10]
    r = {
        "n": int(cv.size),
        "p10_p90_stops": float(np.log2(q[90] / q[10])),
        "p50_p95_stops": float(np.log2(q[95] / q[50])),
        "lit_over_shadow": float(cv[lit].mean() / cv[sh].mean()),
        "seam_over_median": float(cv[seam].mean() / q[50]),
        "p95_over_p5": float(q[95] / q[5]),
        "median_c": q[50],
    }
    # 对数直方图（半档一格，相对中位）
    hb = np.arange(-6, 3.01, 0.5)
    hist, _ = np.histogram(lc - np.log2(q[50]), bins=hb)
    r["loghist_rel_median"] = {f"{hb[k]:+.1f}": round(float(hist[k] / cv.size), 3) for k in range(len(hist))}
    # 分量
    comps = {}
    for key, v in (("amb", "noAmb"), ("ms", "noMS"), ("tail", "noTail")):
        d = load(jdir, v)
        if d is None:
            continue
        Av, Yv = d
        comps[key] = (Y - Yv)[m] / np.maximum(A[m], 1e-6)
    if comps:
        rest = cv - sum(comps.values())
        comps["sun1"] = rest
        cr = {}
        for name, sel in (("lit", lit), ("shadow", sh), ("seam", seam), ("all", np.ones_like(lit))):
            tot = cv[sel].sum()
            cr[name] = {k: round(float(val[sel].sum() / tot), 3) for k, val in comps.items()}
        r["component_share"] = cr
        # 如果把某分量去掉，受光 / 背光比变成多少
        for k in comps:
            cc = cv - comps[k]
            r[f"lit_over_shadow_without_{k}"] = float(cc[lit].mean() / max(cc[sh].mean(), 1e-12))
    # 显示
    disp = {}
    for v in SHOTVARS:
        p = os.path.join(jdir, f"{v}.png")
        if not os.path.exists(p):
            continue
        L = luma_png(p)
        xi = np.clip(X.astype(int), 0, 1599)
        yi = np.clip(Yy.astype(int), 0, 1199)
        dv = L[yi, xi][m]
        litd = dv[cv >= q[50]]
        # 每档多少级：按 log2 c 分 0.25 档分箱取显示中位，求相邻箱斜率
        bins = np.arange(np.floor(lc.min() * 4) / 4, lc.max() + 0.25, 0.25)
        idx = np.digitize(lc, bins)
        med = []
        for b in range(1, len(bins)):
            s = dv[idx == b]
            if s.size >= 30:
                med.append((float(bins[b - 1] + 0.125), float(np.median(s))))
        slopes = [(med[k + 1][1] - med[k][1]) / (med[k + 1][0] - med[k][0]) for k in range(len(med) - 1)]
        # 受光段（c ≥ p50）的斜率
        lit_lo = np.log2(q[50])
        slit = [(med[k + 1][1] - med[k][1]) / 0.25 for k in range(len(med) - 1) if med[k][0] >= lit_lo]
        disp[v] = {
            "all_p10_p90_levels": float(np.percentile(dv, 90) - np.percentile(dv, 10)),
            "lit_p10_p90_levels": float(np.percentile(litd, 90) - np.percentile(litd, 10)),
            "p50": float(np.percentile(dv, 50)), "p95": float(np.percentile(dv, 95)),
            "p95_minus_p50": float(np.percentile(dv, 95) - np.percentile(dv, 50)),
            "levels_per_stop_all_median": float(np.median(slopes)) if slopes else None,
            "levels_per_stop_lit_median": float(np.median(slit)) if slit else None,
            "ge250_pct": float((dv >= 250).mean() * 100),
            "curve": [(round(a, 2), round(b, 1)) for a, b in med],
        }
    r["display"] = disp
    # --alt v1,v2：其他变体（同一机位）按各自分位的 HDR 指标；--odvar：把 S 换成 od 的变体，按 cur 的分类报均值
    alts = {}
    for v in [s for s in opt.get("alt", "").split(",") if s]:
        d = load(jdir, v)
        if d is None:
            continue
        Av, Yv = d
        mv = m & (Av >= 0.9)
        cvv = Yv[mv] / Av[mv]
        cvv = cvv[cvv > 0]
        qq = {k: float(np.percentile(cvv, k)) for k in (5, 10, 20, 50, 60, 90, 95)}
        alts[v] = {
            "p10_p90_stops": float(np.log2(qq[90] / qq[10])), "p50_p95_stops": float(np.log2(qq[95] / qq[50])),
            "lit_over_shadow": float(cvv[cvv >= qq[60]].mean() / cvv[cvv <= qq[20]].mean()),
            "seam_over_median": float(cvv[cvv <= qq[10]].mean() / qq[50]),
            "p90_rel_cur": qq[90] / q[90], "p50_rel_cur": qq[50] / q[50],
        }
    r["alts"] = alts
    if "odvar" in opt:
        d = load(jdir, opt["odvar"])
        if d is not None:
            Av, Yv = d
            odv = Yv[m] / np.maximum(Av[m], 1e-6)
            r["od_by_class"] = {n: float(np.median(odv[s])) for n, s in (("lit", lit), ("shadow", sh), ("seam", seam))}
    out[job] = r
    print(f"\n== {job}（不透明云 {cv.size} px，c 中位 {q[50]:.3g}）")
    print(f"  HDR：p10→p90 {r['p10_p90_stops']:.2f} 档，p50→p95 {r['p50_p95_stops']:.2f} 档，受光/背光 {r['lit_over_shadow']:.2f}，云缝/中位 {r['seam_over_median']:.3f}，p95/p5 {r['p95_over_p5']:.2f}")
    if comps:
        for k, vv in r["component_share"].items():
            print(f"  分量占比 {k}: {vv}")
        print("  去掉某分量后的受光/背光：" + "，".join(f"{k} {r[f'lit_over_shadow_without_{k}']:.2f}" for k in comps))
    for v, d in disp.items():
        print(f"  显示[{v}]：整片 p10–p90 {d['all_p10_p90_levels']:.0f} 级，受光面 p10–p90 {d['lit_p10_p90_levels']:.0f} 级，p95−p50 {d['p95_minus_p50']:.0f}，每档 {d['levels_per_stop_all_median']:.1f} 级（受光段 {d['levels_per_stop_lit_median']}），≥250 {d['ge250_pct']:.3f}%")
        print(f"    曲线（log2 c → 显示中位）：{d['curve']}")
    for v, a in r["alts"].items():
        print(f"  变体 {v}：p10→p90 {a['p10_p90_stops']:.2f} 档，p50→p95 {a['p50_p95_stops']:.2f}，受光/背光 {a['lit_over_shadow']:.2f}，云缝/中位 {a['seam_over_median']:.3f}，p90 相对 cur {a['p90_rel_cur']:.3f}，p50 {a['p50_rel_cur']:.3f}")
    if "od_by_class" in r:
        print(f"  受光 od 中位（按 cur 的分类）：{r['od_by_class']}")
if "json" in opt:
    json.dump(out, open(opt["json"], "w", encoding="utf-8"), ensure_ascii=False, indent=1)
