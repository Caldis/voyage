"""SPEC-BOW：虹 / 云虹的光学参数离线计算（只用 numpy）。

用法：python handoff/SPEC-BOW-optics.py [--emit]
  不带参数：打印各项核对数字（Descartes 角、相函数量级、模型与数值解的误差）。
  --emit：额外打印可以直接贴进 optics.glsl.ts 的常量表。

内容：
1. 水的折射率 n(λ)：Daimon & Masumura 2007（Applied Optics 46(18):3811）20 °C 的四项 Sellmeier 式。
2. 色匹配：CIE 1931 2° 色匹配函数的多瓣高斯解析近似（Wyman, Sloan & Shirley 2013, JCGT 2(2)），XYZ → 线性 sRGB（IEC 61966-2-1）。
   光谱按若干代表波长离散，每个代表波长的权重 = 它那一段光谱上色匹配函数（换成 RGB）的积分，按「等能白 → (1,1,1)」归一。
3. 雨滴（几何光学，a ≫ λ）：k = 0（外反射）/ 1（主虹，一次内反射）/ 2（副虹，两次内反射），k 为内反射次数三族光线，
   Fresnel 按 s、p 两个偏振分别算再平均；对入射参数 b 均匀取样、按散射角直方图得到归一化相函数（∫p dΩ = 1，
   含衍射峰：几何部分只占消光的一半）。再与太阳圆盘（角半径 0.2667°）和 Airy 展宽 + 雨滴谱（高斯 σ，估算）卷积。
4. 云滴（Mie，BHMIE 算法，Bohren & Huffman 1983 附录 A 的写法）：有效半径 5–20 µm、伽马分布（有效方差 0.1），
   算出云虹的 RGB 相函数，拟合着色器里的参数化形状。
"""
import sys
import numpy as np

sys.stdout.reconfigure(encoding="utf-8")
EMIT = "--emit" in sys.argv
D2R = np.pi / 180


# ---------- 1. 水的折射率 ----------
def n_water(lam_um):
    l2 = lam_um**2
    A = [5.684027565e-1, 1.726177391e-1, 2.086189578e-2, 1.130748688e-1]
    B = [5.101829712e-3, 1.821153936e-2, 2.620722293e-2, 1.069792721e1]
    return np.sqrt(1 + sum(a * l2 / (l2 - b) for a, b in zip(A, B)))


# ---------- 2. 色匹配 ----------
def g(x, mu, s1, s2):
    return np.exp(-0.5 * ((x - mu) / np.where(x < mu, s1, s2)) ** 2)


def cmf(lam_nm):
    x = 1.056 * g(lam_nm, 599.8, 37.9, 31.0) + 0.362 * g(lam_nm, 442.0, 16.0, 26.7) - 0.065 * g(lam_nm, 501.1, 20.4, 26.2)
    y = 0.821 * g(lam_nm, 568.8, 46.9, 40.5) + 0.286 * g(lam_nm, 530.9, 16.3, 31.1)
    z = 1.217 * g(lam_nm, 437.0, 11.8, 36.0) + 0.681 * g(lam_nm, 459.0, 26.0, 13.8)
    return np.stack([x, y, z], -1)


XYZ2RGB = np.array([[3.2406, -1.5372, -0.4986], [-0.9689, 1.8758, 0.0415], [0.0557, -0.2040, 1.0570]])

# 代表波长：400–700 nm 均分 N 段，取段中点
NSPEC = 10
edges = np.linspace(400, 700, NSPEC + 1)
LAM = 0.5 * (edges[:-1] + edges[1:])
fine = np.linspace(380, 720, 3401)
rgb_fine = cmf(fine) @ XYZ2RGB.T
W = np.zeros((NSPEC, 3))
for i in range(NSPEC):
    lo = 380 if i == 0 else edges[i]
    hi = 720 if i == NSPEC - 1 else edges[i + 1]
    m = (fine >= lo) & (fine < hi)
    W[i] = rgb_fine[m].sum(0)
W /= W.sum(0)  # 等能白 → (1,1,1)
NW = n_water(LAM / 1000)


# ---------- 3. 雨滴几何光学 ----------
def fresnel(ci, n):
    """入射角余弦 ci，相对折射率 n：返回 (Rs, Rp)"""
    si = np.sqrt(1 - ci**2)
    st = si / n
    ct = np.sqrt(1 - st**2)
    rs = (ci - n * ct) / (ci + n * ct)
    rp = (n * ci - ct) / (n * ci + ct)
    return rs**2, rp**2


def rain_phase(n, theta_anti_deg, nb=400000):
    """相对对日点的角距 θ（度）上的归一化相函数 p（/sr），含 k = 0, 2, 3。返回 dict：各族分开"""
    b = (np.arange(nb) + 0.5) / nb  # 入射参数 b = sin i（滴半径 = 1）
    i = np.arcsin(b)
    r = np.arcsin(b / n)
    Rs, Rp = fresnel(np.cos(i), n)
    out = {}
    edges_t = np.concatenate([theta_anti_deg - 0.5 * (theta_anti_deg[1] - theta_anti_deg[0]), [theta_anti_deg[-1] + 0.5 * (theta_anti_deg[1] - theta_anti_deg[0])]])
    for k in (0, 1, 2):
        if k == 0:
            dev = np.pi - 2 * i  # 偏向角
            e = 0.5 * (Rs + Rp)
        else:
            dev = k * np.pi + 2 * i - 2 * (k + 1) * r
            e = 0.5 * ((1 - Rs) ** 2 * Rs ** k + (1 - Rp) ** 2 * Rp ** k)
        # 散射角 Θ ∈ [0, π]
        dev = np.mod(dev, 2 * np.pi)
        Th = np.where(dev > np.pi, 2 * np.pi - dev, dev)
        ta = 180 - Th / D2R  # 相对对日点的角距
        # 入射截面上 b..b+db 的能量份额 = 2b db（单位圆面积 π 归一 → 份额 2 b db）
        wgt = e * 2 * b / nb
        h, _ = np.histogram(ta, bins=edges_t, weights=wgt)
        # 每个角度 bin 的立体角
        omega = 2 * np.pi * (np.cos((180 - edges_t[1:]) * D2R) - np.cos((180 - edges_t[:-1]) * D2R))
        omega = np.abs(omega)
        out[k] = 0.5 * h / omega  # 0.5：几何部分只占消光（Q = 2）的一半
    return out


def descartes(n, k):
    ci = np.sqrt((n * n - 1) / (k * (k + 2)))  # cos i at minimum deviation
    i = np.arccos(ci)
    r = np.arcsin(np.sin(i) / n)
    dev = k * np.pi + 2 * i - 2 * (k + 1) * r
    dev = np.mod(dev, 2 * np.pi)
    Th = np.where(dev > np.pi, 2 * np.pi - dev, dev)
    return 180 - Th / D2R


def blur(y, dx, sun_r=0.2667, sigma=0.0):
    """与太阳圆盘（均匀圆盘在一维上的投影：半圆律）和高斯卷积"""
    xs = np.arange(-4, 4 + dx / 2, dx)
    kern = np.sqrt(np.clip(1 - (xs / sun_r) ** 2, 0, None))
    if sigma > 0:
        kg = np.exp(-0.5 * (xs / sigma) ** 2)
        kern = np.convolve(kern, kg, mode="same")
    kern /= kern.sum()
    return np.convolve(y, kern, mode="same")


print("== 1. 水的折射率（Daimon & Masumura 2007，20 °C）==")
for lam in (0.40, 0.45, 0.55, 0.589, 0.65, 0.70):
    print(f"  λ={lam:.3f} µm  n={n_water(lam):.5f}")
print("  （Hale & Querry 1973 参考：0.40→1.339，0.589→1.333，0.70→1.331）")

print("\n== 2. 代表波长与 RGB 权重（等能白归一）==")
for l, n, w in zip(LAM, NW, W):
    print(f"  {l:.0f} nm  n={n:.5f}  w={np.round(w, 4)}")

print("\n== 3. 雨虹：Descartes 角（相对对日点）==")
for l, n in zip(LAM, NW):
    print(f"  {l:.0f} nm  主虹 {descartes(n, 1):.2f}°  副虹 {descartes(n, 2):.2f}°")

dx = 0.02
TH = np.arange(0.01, 70, dx)
SIG_AIRY = 0.25  # 估算：Airy 展宽 + 雨滴谱 + 扁椭球的综合（度）
P = np.zeros((NSPEC, TH.size))
fam = {k: np.zeros((NSPEC, TH.size)) for k in (0, 1, 2)}
for j, n in enumerate(NW):
    ph = rain_phase(n, TH)
    for k in (0, 1, 2):
        fam[k][j] = blur(ph[k], dx, sigma=SIG_AIRY)
    P[j] = fam[0][j] + fam[1][j] + fam[2][j]
RGB = W.T @ P  # (3, TH)
idx = lambda t: int(round((t - TH[0]) / dx))
print("\n== 雨滴相函数（RGB，/sr，等能白光）==")
for t in (5, 20, 30, 38, 40, 41, 41.5, 42, 42.5, 44, 46, 48, 50, 51, 52, 53, 55, 60):
    print(f"  θ={t:5.1f}°  p={np.round(RGB[:, idx(t)], 4)}")
print("  各族在 30° / 46° / 60°（绿）：", [(k, round(fam[k][4][idx(30)], 4), round(fam[k][4][idx(46)], 4), round(fam[k][4][idx(60)], 4)) for k in (0, 1, 2)])

# ---------- 着色器模型：每个代表波长 ----------
# p_k(θ) ≈ A_k · C(x; w) + F_k(θ)，x = 到 Descartes 角的距离（亮侧为正），
# C(x; w) = Re[(x − i w)^(−1/2)]（1/√x 焦散被洛伦兹抹开，解析）；亮侧远处 C → 1/√x，暗侧快速衰减（再乘一段高斯尾）。
# F_1：主虹里面的「填充」（常数 + 随 θ 的缓变），F_2：副虹外面的填充；k = 0 外反射近似常数。
def caustic(x, w):
    m = np.sqrt(x * x + w * w)
    c = np.sqrt(np.maximum(m + x, 0) / 2) / m
    return c * np.where(x < 0, np.exp(-(x / (2.2 * w)) ** 2), 1.0)


def fit_family(j, k):
    y = fam[k][j]
    tD = descartes(NW[j], k)
    x = (tD - TH) if k == 1 else (TH - tD)  # 亮侧为正（弧度）
    xr = x * D2R
    # 拟合 A、w 与亮侧填充 f0 + f1·x + f2·x²：主虹亮侧 0–40°、副虹亮侧 0–20°、暗侧 −3°–0 上最小二乘（w 网格搜索）
    best = None
    for w_deg in np.linspace(0.15, 0.6, 46):
        w = w_deg * D2R
        c = caustic(xr, w)
        lit = (x > 0).astype(float)
        m = (x > -3) & (x < (40 if k == 1 else 20))
        Amat = np.stack([c, lit, lit * xr, lit * xr * xr], -1)[m]
        coef, *_ = np.linalg.lstsq(Amat, y[m], rcond=None)
        err = np.sqrt(np.mean((Amat @ coef - y[m]) ** 2))
        if best is None or err < best[0]:
            best = (err, w_deg, coef)
    return tD, best


print("\n== 模型拟合（每个代表波长；A 的单位 /sr·rad^½，f0 /sr，f1 /sr/rad）==")
MODEL = []
for j in range(NSPEC):
    t2, (e2, w2, c2) = fit_family(j, 1)
    t3, (e3, w3, c3) = fit_family(j, 2)
    r0 = fam[0][j][idx(45)]
    MODEL.append((t2, w2, *c2, t3, w3, *c3, r0))
    print(f"  {LAM[j]:.0f} nm  主 θ={t2:.3f} w={w2:.3f}° A={c2[0]:.5f} f={np.round(c2[1:], 4)} rms={e2:.4f} | 副 θ={t3:.3f} w={w3:.3f}° A={c3[0]:.5f} f={np.round(c3[1:], 4)} rms={e3:.4f} | 反射 {r0:.4f}")
MODEL = np.array(MODEL)
# 着色器里各波长共用一组形状参数（各波长的拟合值只差 1–4%），只有 Descartes 角随波长变：取平均
SH = MODEL.mean(0)
print("共用形状参数：主虹 w=%.3f° A=%.5f f=(%.5f, %.5f, %.5f)；副虹 w=%.3f° A=%.5f f=(%.5f, %.5f, %.5f)" % (SH[1], SH[2], SH[3], SH[4], SH[5], SH[7], SH[8], SH[9], SH[10], SH[11]))


def model_rgb(th_deg):
    out = np.zeros((3, th_deg.size))
    for j in range(NSPEC):
        t2, t3 = MODEL[j][0], MODEL[j][6]
        _, w2, A2, f02, f12, f22, _, w3, A3, f03, f13, f23, r0 = SH
        x2 = (t2 - th_deg) * D2R
        x3 = (th_deg - t3) * D2R
        p1 = A2 * caustic(x2, w2 * D2R) + (x2 > 0) * (f02 + f12 * x2 + f22 * x2 * x2)
        p2 = A3 * caustic(x3, w3 * D2R) + (x3 > 0) * (f03 + f13 * x3 + f23 * x3 * x3)
        p = np.maximum(p1, 0) + np.maximum(p2, 0) + r0
        out += np.outer(W[j], p)
    return out


Mrgb = model_rgb(TH)
sel = (TH > 5) & (TH < 70)
err = np.abs(Mrgb - RGB)[:, sel]
print("\n== 模型 vs 数值（RGB，5°–70°）：最大误差 / 峰值 ==", np.round(err.max(1) / RGB[:, sel].max(1), 3), " 平均相对误差", np.round(err.mean(1) / RGB[:, sel].mean(1), 3))
for t in (5, 15, 25, 30, 38, 40, 41, 41.5, 42, 42.5, 44, 46, 50, 51, 52, 53, 55, 60, 68):
    print(f"  θ={t:5.1f}°  数值 {np.round(RGB[:, idx(t)], 4)}  模型 {np.round(Mrgb[:, idx(t)], 4)}")

# 亮度层级（绿通道 ≈ 亮度）
band = RGB[1][idx(45.5)]
print(f"\n亮度层级（G）：主虹峰 {RGB[1].max():.4f}，主虹内 30° {RGB[1][idx(30)]:.4f}，亚历山大暗带 45.5° {band:.4f}，"
      f"副虹峰 {RGB[1][(TH > 49) & (TH < 56)].max():.4f}，副虹外 58° {RGB[1][idx(58)]:.4f}")
print(f"  主虹峰 / 暗带 = {RGB[1].max() / band:.1f}，副虹峰 / 暗带 = {RGB[1][(TH > 49) & (TH < 56)].max() / band:.1f}，主虹内 / 暗带 = {RGB[1][idx(30)] / band:.2f}")

# ---------- 4. 云滴 Mie ----------
def bhmie(x, m, mu):
    """BHMIE（Bohren & Huffman 1983），返回 S1, S2（mu = cos Θ 数组）"""
    nstop = int(x + 4.05 * x ** (1 / 3) + 2)
    y = m * x
    nmx = int(max(nstop, abs(y)) + 16)
    D = np.zeros(nmx + 1, dtype=complex)
    for n in range(nmx, 0, -1):
        D[n - 1] = n / y - 1 / (D[n] + n / y)
    psi0, psi1 = np.cos(x), np.sin(x)
    chi0, chi1 = -np.sin(x), np.cos(x)
    xi1 = complex(psi1, -chi1)
    pi0 = np.zeros_like(mu)
    pi1 = np.ones_like(mu)
    S1 = np.zeros_like(mu, dtype=complex)
    S2 = np.zeros_like(mu, dtype=complex)
    qext = 0.0
    for n in range(1, nstop + 1):
        fn = (2 * n + 1) / (n * (n + 1))
        psi = (2 * n - 1) * psi1 / x - psi0
        chi = (2 * n - 1) * chi1 / x - chi0
        xi = complex(psi, -chi)
        an = ((D[n] / m + n / x) * psi - psi1) / ((D[n] / m + n / x) * xi - xi1)
        bn = ((D[n] * m + n / x) * psi - psi1) / ((D[n] * m + n / x) * xi - xi1)
        qext += (2 * n + 1) * (an + bn).real
        pi = pi1
        tau = n * mu * pi - (n + 1) * pi0
        S1 += fn * (an * pi + bn * tau)
        S2 += fn * (an * tau + bn * pi)
        pi1_new = ((2 * n + 1) * mu * pi - (n + 1) * pi0) / n
        pi0, pi1 = pi, pi1_new
        psi0, psi1 = psi1, psi
        chi0, chi1 = chi1, chi
        xi1 = complex(psi1, -chi1)
    qext *= 2 / x**2
    return S1, S2, qext


def cloud_phase(reff_um, lam_um, th_anti_deg, veff=0.1, nr=24):
    """伽马分布（有效半径 reff、有效方差 veff）的归一化相函数 p（/sr），θ 为相对对日点的角距"""
    mu = np.cos((180 - th_anti_deg) * D2R)
    a_alpha = 1 / veff - 3
    rb = reff_um * veff * np.arange(1, nr + 1) / nr * 0 + 0  # 占位
    rs = np.linspace(reff_um * (1 - 2.5 * np.sqrt(veff)), reff_um * (1 + 3 * np.sqrt(veff)), nr)
    rs = rs[rs > 0.5]
    b = 1 / (reff_um * veff)
    nd = rs**a_alpha * np.exp(-b * rs)
    m = complex(n_water(lam_um), 0)
    num = np.zeros_like(mu)
    den = 0.0
    for r, w in zip(rs, nd):
        x = 2 * np.pi * r / lam_um
        S1, S2, qext = bhmie(x, m, mu)
        i = 0.5 * (abs(S1) ** 2 + abs(S2) ** 2)
        # 散射截面 σ_s = qext·πr²（水不吸收，qsca = qext）；p = i / (k² σ_s)
        k = 2 * np.pi / lam_um
        num += w * i / k**2
        den += w * qext * np.pi * r**2
    return num / den


print("\n== 云虹（Mie，伽马分布 veff = 0.1）：RGB 相函数（/sr）==")
THC = np.arange(20, 60.01, 0.1)
CLOUD = {}
for reff in (5, 7, 10, 14, 20):
    Pc = np.array([cloud_phase(reff, l / 1000, THC) for l in LAM])
    rgbc = W.T @ Pc
    rgbc = np.array([blur(ch, 0.1, sun_r=0.2667) for ch in rgbc])
    CLOUD[reff] = rgbc
    pk = [THC[np.argmax(ch * ((THC > 30) & (THC < 50)))] for ch in rgbc]
    ref = rgbc[:, np.argmin(np.abs(THC - 25))]
    print(f"  reff={reff:2d} µm  峰位 RGB = {np.round(pk, 1)}°  峰值 {np.round([ch.max() for ch in rgbc], 4)}  25° 处 {np.round(ref, 4)}  "
          f"半高全宽（G）{np.ptp(THC[rgbc[1] > 0.5 * (rgbc[1].max() + rgbc[1][np.argmin(np.abs(THC - 25))])]):.1f}°")
    if EMIT:
        for t in (25, 30, 33, 35, 37, 38, 39, 40, 41, 42, 43, 45, 48, 52):
            print(f"      θ={t:4.1f}° {np.round(rgbc[:, np.argmin(np.abs(THC - t))], 4)}")

# ---------- 云虹的参数化形状（每个通道）----------
# p(θ) = b_out + (b_in − b_out)·σ((θc − θ)/s) + P·exp(−((θ − θc)/s)²)，σ 为 logistic；θc、s 网格搜索，其余线性最小二乘，拟合区间 20°–56°
def fit_cloudbow(th, y):
    best = None
    for tc in np.arange(33, 42.01, 0.1):
        for sw in np.arange(1.0, 5.01, 0.1):
            G = np.exp(-(((th - tc) / sw) ** 2))
            S = 1 / (1 + np.exp((th - tc) / sw))
            A = np.stack([G, S, np.ones_like(th)], -1)
            coef, *_ = np.linalg.lstsq(A, y, rcond=None)
            e = np.sqrt(np.mean((A @ coef - y) ** 2))
            if best is None or e < best[0]:
                best = (e, tc, sw, coef)
    e, tc, sw, (P, dIn, bOut) = best
    return tc, sw, P, bOut + dIn, bOut, e


print("\n== 云虹参数化拟合（每个通道：θc°, s°, P, b_in, b_out, rms；/sr）==")
msk = (THC >= 20) & (THC <= 56)
CB = {}
for reff, rgbc in CLOUD.items():
    rows = [fit_cloudbow(THC[msk], ch[msk]) for ch in rgbc]
    CB[reff] = rows
    for c, r in zip("RGB", rows):
        print(f"  reff={reff:2d} {c}: θc={r[0]:.1f} s={r[1]:.1f} P={r[2]:.4f} b_in={r[3]:.4f} b_out={r[4]:.4f} rms={r[5]:.4f}")
print("\n// TS 表（optics.ts 的 CLOUDBOW_TABLE）：[reff µm, θc(R,G,B)°, s(R,G,B)°, P(R,G,B), b_in(RGB 平均), b_out(RGB 平均)]")
for reff, rows in CB.items():
    r = np.array(rows)
    print(f"  [{reff}, [{r[0,0]:.1f}, {r[1,0]:.1f}, {r[2,0]:.1f}], [{r[0,1]:.1f}, {r[1,1]:.1f}, {r[2,1]:.1f}], [{r[0,2]:.4f}, {r[1,2]:.4f}, {r[2,2]:.4f}], {r[:,3].mean():.4f}, {r[:,4].mean():.4f}],")

if EMIT:
    print("\n== 贴进着色器的常量 ==")
    print("const int BOW_NSPEC =", NSPEC)
    for j in range(NSPEC):
        t2, w2, A2, f02, f12, t3, w3, A3, f03, f13, r0 = MODEL[j]
        print(f"  // {LAM[j]:.0f} nm: W={np.round(W[j], 4)}")
        print(f"  vec4({t2:.3f}, {w2:.3f}, {A2:.5f}, {f02:.5f}), vec4({f12:.5f}, {t3:.3f}, {w3:.3f}, {A3:.5f}), vec2({f03:.5f}, {f13:.5f}), r0={r0:.5f}")
