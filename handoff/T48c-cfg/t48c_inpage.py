# python t48c_inpage.py <inpage.json>
import sys, json
import numpy as np
sys.stdout.reconfigure(encoding="utf-8")
D = json.load(open(sys.argv[1], encoding="utf-8"))
# 配对：同一轮里相邻的两段（内容相近）比「帧间 |Δ|/均值」，报 各模式 / 第一个模式 的逐轮比值中位数与四分位
def seg_metric(s):
    mu = np.array([f["mean"] for f in s["frames"]]); return np.mean(np.abs(np.diff(mu))) / mu.mean()
names = list(D.keys())
base = names[0]
for m in names[1:]:
    r = np.array([seg_metric(a) / seg_metric(b) for a, b in zip(D[m], D[base])])
    print(f"配对 {m}/{base} 帧间抖动比：中位 {np.median(r):.2f}（四分位 {np.percentile(r,25):.2f}–{np.percentile(r,75):.2f}，{len(r)} 轮，>1 的轮数 {(r>1).sum()}）")
# 去趋势抖动：每段对均值 / 每个分块按时间做二次拟合，残差 std ÷ 均值——去掉画面平移造成的缓慢漂移，只剩「闪」
def detr(y):
    t = np.arange(len(y)); c = np.polyfit(t, y, 2)
    return y - np.polyval(c, t)
def seg_flicker(s):
    mu = np.array([f["mean"] for f in s["frames"]])
    T = np.array([f["tiles"] for f in s["frames"]])
    t = np.arange(len(mu))
    V = np.vander(t, 3)
    coef, *_ = np.linalg.lstsq(V, T, rcond=None)
    R = T - V @ coef
    tile = np.percentile(R.std(0) / np.maximum(T.mean(0), 1), 95)
    return detr(mu).std() / mu.mean(), tile
for m in names:
    f = np.array([seg_flicker(s) for s in D[m]]) * 100
    print(f"去趋势 {m:8s} 整片 中位 {np.median(f[:,0]):.3f}% 分块 p95 中位 {np.median(f[:,1]):.2f}%")
for m in names[1:]:
    r = np.array([seg_flicker(a)[0] / seg_flicker(b)[0] for a, b in zip(D[m], D[base])])
    r2 = np.array([seg_flicker(a)[1] / seg_flicker(b)[1] for a, b in zip(D[m], D[base])])
    print(f"去趋势配对 {m}/{base}：整片 中位 {np.median(r):.2f}（{np.percentile(r,25):.2f}–{np.percentile(r,75):.2f}） 分块 中位 {np.median(r2):.2f}（{np.percentile(r2,25):.2f}–{np.percentile(r2,75):.2f}）")
for m in names:
    v = np.array([seg_metric(s) for s in D[m]]) * 100
    print(f"逐段 {m:8s} 帧间 |Δ|/均值 中位 {np.median(v):.3f}% 四分位 {np.percentile(v,25):.3f}–{np.percentile(v,75):.3f}%")
for m, segs in D.items():
    mus, rstd, dm, rel, dts, mx = [], [], [], [], [], []
    for s in segs:
        mu = np.array([f["mean"] for f in s["frames"]])
        T = np.array([f["tiles"] for f in s["frames"]])
        mus.append(mu.mean()); rstd.append(mu.std() / mu.mean())
        d = np.abs(np.diff(mu)) / mu.mean(); dm += list(d)
        # 高通：帧间差减去相邻差的平均（去掉匀速移动造成的线性漂移），看「抖」
        acc = np.abs(np.diff(mu, 2)) / mu.mean(); mx += list(acc)
        rel.append((np.abs(np.diff(T, axis=0)) / np.maximum(T[:-1], 1)).ravel())
        dts += s["dts"][1:]
    rel = np.concatenate(rel)
    print(f"{m:8s} {len(segs)} 段×{len(segs[0]['frames'])} 帧 均值 {np.mean(mus):6.2f} 段内相对 std {np.mean(rstd)*100:.2f}% 帧间 |Δ|/均值 {np.mean(dm)*100:.3f}% 二阶差 {np.mean(mx)*100:.3f}%（p99 {np.percentile(mx,99)*100:.3f}%） 分块 p95 {np.percentile(rel,95)*100:.2f}% dt 中位 {np.median(dts):.1f} ms p95 {np.percentile(dts,95):.1f}")
