"""SEA-3：生成诊断 / 验收用的 ab、gpu-ab jobs（写到 handoff/ 下）。

用法（仓库根）：python apps/voyage/handoff/SEA-3-mkjobs.py <组名>
低空（< 4 km）画的是低空细节变体，pre 把它挂到 __voyage.__outCur 再 patch（WX11g-b 的绕法）。
"""
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
PRE = (
    "for (let i = 0; i < 1200 && v.groundDetail.pending; i++) await new Promise((r) => requestAnimationFrame(r)); "
    "const k = v.groundDetail.shown; v.__outCur = k ? v.groundDetail.variants.get(k).material : v.outsideMat; "
    "return 'shown=' + JSON.stringify(k);"
)

SCENES = {
    "hnd-low-day": {"preset": "hnd-cts", "date": "2026-09-28", "time": 900, "altitude": 1.5, "coverage": 0.1, "wing-pos": "-4"},
    "hnd-low-day-26": {"preset": "hnd-cts", "date": "2026-09-28", "time": 900, "altitude": 2.6, "coverage": 0.1, "wing-pos": "-4"},
    "cruise-ground": {"preset": "hnd-cts", "date": "2026-09-28", "time": 780, "altitude": 10.7, "coverage": 0.05, "wing-pos": "8"},
    "noon-cu-close": {"preset": "wpac", "date": "2026-09-28", "time": 750, "altitude": 3, "coverage": 0.45, "wing-pos": "-4"},
    "sea-mod-low": {"preset": "wpac", "date": "2026-09-28", "time": 870, "coverage": 0.1, "altitude": 0.8, "wind": 8, "wing-pos": "-4"},
    "noon-cumulus": {"preset": "wpac", "date": "2026-09-28", "time": 720, "wing-pos": "8"},
    "sunset": {"preset": "wpac", "date": "2026-09-28", "time": 1040, "wing-pos": "8"},
    "wpac-cruise": {"preset": "wpac", "date": "2026-09-28", "time": 870, "coverage": 0.05, "altitude": 10.7, "wind": 7, "wing-pos": "8"},
}
GROUND = {"hnd-low-day", "hnd-low-day-26", "cruise-ground"}
HEAD = {"cruise-ground": [0, 0.14, -0.2], "wpac-cruise": [0, 0.14, -0.2]}

GF = "      L = groundFinish(gh, land, water, fView, skyCam, eSunW, eSkyW, eFlash);\n"
REFL = "      L += refl;\n"


def scene(name):
    s = {"name": name, "p": SCENES[name]}
    if name in GROUND:
        s["ground"] = True
    if name in HEAD:
        s["head"] = HEAD[name]
    return s


def job(name, variants, crop=None, zoom=None, extra=None):
    j = {"name": name, "scene": scene(name.split("@")[0]), "pre": PRE, "variants": variants}
    if crop:
        j["crop"] = crop
    if zoom:
        j["zoom"] = zoom
    if extra:
        j.update(extra)
    return j


def patch(pairs):
    return {"patch": {"__outCur": [list(p) for p in pairs]}}


def dbg(n):
    return {"uniforms": {"__outCur.uniforms.uDebug.value": n}}


def diag_wall():
    vs = [
        {"name": "cur"},
        {"name": "tintGround", **patch([(GF, GF + "      L *= vec3(1.6, 0.6, 0.6);\n")])},
        {"name": "tintSea", **patch([(REFL, REFL + "      L *= vec3(0.6, 0.6, 1.6);\n")])},
        {"name": "dbg5-sea", **dbg(5)},
        {"name": "dbg6-refl", **dbg(6)},
        {"name": "dbg7-insc", **dbg(7)},
    ]
    return [job("hnd-low-day", vs, crop=[400, 400, 800, 300]), job("hnd-low-day-26", vs, crop=[400, 400, 800, 300])]


SKYL = "  if (!onGround) L = skyRadiance(rd, hitGround);\n"
EXACT_AP = "      { vec3 Tx; gh.apL = integrateSegment(ro, rd, uSunDir, gh.t, 64.0, Tx) * uSunIlluminance; gh.apT = Tx; }\n"
EXACT_SKY = "  if (!onGround) { vec3 Tx; L = integrateSegment(ro, rd, uSunDir, 1e9, 64.0, Tx) * uSunIlluminance; }\n"
FIN_RET = "  L = L * gh.apT + gh.wat.r * (water * gh.apT + fView * max(skyCam - gh.apL, vec3(0.0)));\n  return L + gh.apL;\n"


def fin(expr):
    return (FIN_RET, f"  L = L * gh.apT + gh.wat.r * (water * gh.apT + fView * max(skyCam - gh.apL, vec3(0.0)));\n  return {expr};\n")


def diag_wall2():
    vs = [
        {"name": "cur"},
        {"name": "exactSky", **patch([(SKYL, EXACT_SKY)])},
        {"name": "exactAP", **patch([(GF, EXACT_AP + GF)])},
        {"name": "exactBoth", **patch([(GF, EXACT_AP + GF), (SKYL, EXACT_SKY)])},
        {"name": "c-apL", **patch([fin("gh.apL")])},
        {"name": "c-refl", **patch([fin("gh.wat.r * fView * max(skyCam - gh.apL, vec3(0.0))")])},
        {"name": "c-skyCam", **patch([fin("skyCam")])},
        {"name": "c-waterT", **patch([fin("gh.wat.r * water * gh.apT")])},
        {"name": "c-F", **patch([fin("vec3(fView) * 2000.0")])},
    ]
    return [job("hnd-low-day", vs, crop=[400, 400, 800, 300])]


REL = "  float rel = gustFactor(xzKm) * slickFactor(xzKm) * mix(1.0, 0.45, shallow);\n"
BODY = "      body = gh.alb.rgb * 0.7;\n"
SIG = "  float sigma2 = sl.var;\n"


def diag_stripes():
    vs = [
        {"name": "cur"},
        {"name": "noSlick", **patch([(REL, REL.replace(" * slickFactor(xzKm)", ""))])},
        {"name": "noGust", **patch([(REL, REL.replace("gustFactor(xzKm) * ", ""))])},
        {"name": "bodyDefault", **patch([(BODY, "      body = vec3(-1.0);\n")])},
        {"name": "sigmaCM", **patch([(SIG, "  float sigma2 = cmLocal; sl.mean = vec2(0.0); nView = n;\n")])},
        {"name": "dbg8", **dbg(8)},
        {"name": "dbg11", **dbg(11)},
        {"name": "dbg12", **dbg(12)},
    ]
    return [job("cruise-ground", vs, crop=[700, 60, 550, 260])]


def diag_wall3():
    vs = [{"name": "cur"}] + [
        {"name": f"exactSky{n}", **patch([(SKYL, EXACT_SKY.replace("64.0", f"{n}.0"))])} for n in (24, 40, 64)
    ]
    return [job("hnd-low-day", vs, crop=[400, 400, 800, 300]), job("hnd-low-day-26", vs, crop=[400, 400, 800, 300])]


SKYCAM = "      skyCam = skyRadiance(reflect(rd, nView), false);\n"
EXACT_SKYCAM = "      { vec3 Tx; skyCam = integrateSegment(ro, reflect(rd, nView), uSunDir, 1e9, 64.0, Tx) * uSunIlluminance; }\n"


def diag_stripes2():
    vs = [
        {"name": "cur"},
        {"name": "exactAP", **patch([(GF, EXACT_AP + GF)])},
        {"name": "exactSkyCam", **patch([(SKYCAM, EXACT_SKYCAM)])},
        {"name": "exactBoth", **patch([(GF, EXACT_AP + GF), (SKYCAM, EXACT_SKYCAM)])},
        {"name": "c-apL", **patch([fin("gh.apL")])},
        {"name": "c-apT", **patch([fin("gh.apT * 20000.0")])},
        {"name": "c-refl", **patch([fin("gh.wat.r * fView * max(skyCam - gh.apL, vec3(0.0))")])},
        {"name": "c-skyCam", **patch([fin("skyCam")])},
    ]
    return [job("cruise-ground", vs, crop=[700, 60, 550, 260])]


# 逐像素积分要带上边界层霾：uHaze / uHazeShape 平时只接在 LUT 材质上（窗外程序里不可达、值为默认 0 = 无霾），
# 诊断时把 LUT 用的那两个 uniform 对象挂进窗外材质
PRE_HAZE = PRE.replace(
    "return 'shown=",
    "v.__outCur.uniforms.uHaze = v.atmosphere.hazeUniforms.uHaze; v.__outCur.uniforms.uHazeShape = v.atmosphere.hazeUniforms.uHazeShape; "
    "return 'haze=' + v.atmosphere.hazeUniforms.uHaze.value.toArray().map((x) => x.toFixed(3)) + ' shown=",
)


def diag_truth():
    wall = [
        {"name": "cur"},
        {"name": "exactSky", **patch([(SKYL, EXACT_SKY)])},
        {"name": "exactBoth", **patch([(GF, EXACT_AP + GF), (SKYL, EXACT_SKY)])},
        {"name": "exactAll", **patch([(GF, EXACT_AP + GF), (SKYL, EXACT_SKY), (SKYCAM, EXACT_SKYCAM)])},
    ]
    stripes = [
        {"name": "cur"},
        {"name": "exactAP", **patch([(GF, EXACT_AP + GF)])},
        {"name": "exactSkyCam", **patch([(SKYCAM, EXACT_SKYCAM)])},
        {"name": "exactAll", **patch([(GF, EXACT_AP + GF), (SKYL, EXACT_SKY), (SKYCAM, EXACT_SKYCAM)])},
    ]
    return [
        job("hnd-low-day", wall, crop=[400, 400, 800, 300], extra={"pre": PRE_HAZE}),
        job("hnd-low-day-26", wall, crop=[400, 400, 800, 300], extra={"pre": PRE_HAZE}),
        job("cruise-ground", stripes, crop=[700, 60, 550, 260], extra={"pre": PRE_HAZE}),
    ]


GF_REFL = "fView * max(skyCam - gh.apL, vec3(0.0))"
GF_REFL_CLAMP = "fView * clamp(skyCam - gh.apL, vec3(0.0), gh.apT * skyCam)"
OS_REFL = "      vec3 refl = fView * max(skyCam - inscatter, vec3(0.0));\n"
OS_REFL_CLAMP = "      vec3 refl = fView * clamp(skyCam - inscatter, vec3(0.0), tView * skyCam);\n"
AERIAL_SAMPLES = "dist, 24.0, T);"


def aerial(n):
    return {"patch": {"atmosphere.aerialMaterial": [[AERIAL_SAMPLES, f"dist, {n}.0, T);"]]}}


def proto():
    clamp = {"name": "reflClamp", **patch([(GF_REFL, GF_REFL_CLAMP), (OS_REFL, OS_REFL_CLAMP)])}
    stripes = [
        {"name": "cur"},
        {"name": "exactAP24", **patch([(GF, EXACT_AP.replace("64.0", "24.0") + GF)])},
        {"name": "exactAP64", **patch([(GF, EXACT_AP + GF)])},
        {"name": "lutAP48", **aerial(48)},
        {"name": "lutAP64", **aerial(64)},
        clamp,
    ]
    wall = [{"name": "cur"}, clamp, {"name": "lutAP64", **aerial(64)}]
    side = [{"name": "cur"}, clamp, {"name": "lutAP64", **aerial(64)}]
    return [
        job("cruise-ground", stripes, crop=[700, 60, 550, 260], extra={"pre": PRE_HAZE}),
        job("hnd-low-day", wall, crop=[400, 400, 800, 300]),
        job("hnd-low-day-26", wall, crop=[400, 400, 800, 300]),
        job("sea-mod-low", side, crop=[400, 400, 800, 600]),
        job("wpac-cruise", side, crop=[400, 100, 800, 800]),
        job("noon-cumulus", side, crop=[400, 100, 800, 800]),
    ]


# 方案 B：水面看到的反射天空 = 按「水面处往反射方向到大气顶的透射率 tUp」在两者间混合：
#   tUp → 1（反射方向很快出霾）：沿用原来的 L相机(反射方向) − 内散射；
#   tUp → 0（掠射、水面埋在霾里）：水面反射的是霾本身，亮度取视线这段霾的「饱和内散射」apL / (1 − apT)，再乘 apT 传到相机
SKYCAM_SURF = (
    SKYCAM
    + "      if (onGround) {\n"
    "        float sEps = max(dot(reflect(rd, nView), n), 0.0);\n"
    "        vec3 tUp = transmittanceToTop(BOTTOM, sEps);\n"
    "        vec3 hazeR = gh.apT * gh.apL / max(vec3(1.0) - gh.apT, vec3(1e-3));\n"
    "        skyCam = gh.apL + mix(hazeR, max(skyCam - gh.apL, vec3(0.0)), tUp);\n"
    "      }\n"
)
OS_REFL_SURF = (
    "      vec3 tUpR = transmittanceToTop(BOTTOM, max(dot(reflect(rd, nView), n), 0.0));\n"
    "      vec3 refl = fView * mix(tView * inscatter / max(vec3(1.0) - tView, vec3(1e-3)), max(skyCam - inscatter, vec3(0.0)), tUpR);\n"
)


def proto2():
    surf = {"name": "reflSurf", **patch([(SKYCAM, SKYCAM_SURF), (OS_REFL, OS_REFL_SURF)])}
    vs = [{"name": "cur"}, surf]
    return [
        job("hnd-low-day", vs, crop=[400, 400, 800, 300]),
        job("hnd-low-day-26", vs, crop=[400, 400, 800, 300]),
        job("cruise-ground", vs, crop=[700, 60, 550, 260]),
        job("sea-mod-low", vs, crop=[400, 400, 800, 600]),
        job("wpac-cruise", vs, crop=[400, 100, 800, 800]),
        job("noon-cumulus", vs, crop=[400, 100, 800, 800]),
        job("sunset", vs, crop=[400, 100, 800, 800]),
    ]


AP_FETCH = (
    "  gh.apL = texture(uAerialInscatterS, uvw).rgb * uSunIlluminance;\n"
    "  gh.apT = texture(uAerialTransmittanceS, uvw).rgb;\n"
)


def ap_bspline(ax):
    """空气透视 LUT 沿某一轴（z = 距离层，y = 天顶角行）改成三次 B 样条重建（两次线性取样），看横纹是否消失"""
    D = {"z": "AERIAL_SIZE.z", "y": "AERIAL_SIZE.y"}[ax]
    other = {"z": "vec3(uvw.xy, {p})", "y": "vec3(uvw.x, {p}, uvw.z)"}[ax]
    return (
        "  { float Dz = " + D + "; float f = uvw." + ax + " * Dz - 0.5; float i = floor(f); float t = f - i;\n"
        "    float t2 = t * t, t3 = t2 * t;\n"
        "    float w0 = (1.0 - 3.0 * t + 3.0 * t2 - t3) / 6.0, w1 = (4.0 - 6.0 * t2 + 3.0 * t3) / 6.0;\n"
        "    float w2 = (1.0 + 3.0 * t + 3.0 * t2 - 3.0 * t3) / 6.0, w3 = t3 / 6.0;\n"
        "    float g0 = w0 + w1, g1 = w2 + w3;\n"
        "    vec3 a = " + other.format(p="(i - 1.0 + w1 / g0 + 0.5) / Dz") + ", b = " + other.format(p="(i + 1.0 + w3 / g1 + 0.5) / Dz") + ";\n"
        "    gh.apL = (g0 * texture(uAerialInscatterS, a).rgb + g1 * texture(uAerialInscatterS, b).rgb) * uSunIlluminance;\n"
        "    gh.apT = g0 * texture(uAerialTransmittanceS, a).rgb + g1 * texture(uAerialTransmittanceS, b).rgb; }\n"
    )


def diag_stripes3():
    vs = [
        {"name": "cur"},
        {"name": "bsplineZ", **patch([(AP_FETCH, ap_bspline("z"))])},
        {"name": "bsplineY", **patch([(AP_FETCH, ap_bspline("y"))])},
        {"name": "exactAP24", **patch([(GF, EXACT_AP.replace("64.0", "24.0") + GF)])},
    ]
    return [
        job("cruise-ground", vs, crop=[700, 60, 550, 260], extra={"pre": PRE_HAZE}),
        job("wpac-cruise", vs, crop=[700, 60, 550, 260], extra={"pre": PRE_HAZE}),
    ]


# 空气透视 LUT 沿距离轴按「均匀介质段」插值：透射率在两层之间按距离做对数线性（指数衰减的精确形状），
# 内散射按透射率的比例插值（均匀段内 L 与 T 线性相关：L = La + S·(Ta − T)/β）。一个均匀段内精确，霾里 12 km 一层也不再是折线
AP_LOGZ = (
    "  { float Dz = AERIAL_SIZE.z; float zu = sqrt(clamp(tT / AERIAL_MAX_DISTANCE, 0.0, 1.0)) * (Dz - 1.0);\n"
    "    float k0 = min(floor(zu), Dz - 2.0);\n"
    "    float za = k0 / (Dz - 1.0), zb = (k0 + 1.0) / (Dz - 1.0);\n"
    "    float da = za * za * AERIAL_MAX_DISTANCE, db = zb * zb * AERIAL_MAX_DISTANCE;\n"
    "    float td = clamp((tT - da) / max(db - da, 1e-6), 0.0, 1.0);\n"
    "    vec3 a = vec3(uvw.xy, unitToUv(za, Dz)), b = vec3(uvw.xy, unitToUv(zb, Dz));\n"
    "    vec3 Ta = texture(uAerialTransmittanceS, a).rgb, Tb = texture(uAerialTransmittanceS, b).rgb;\n"
    "    vec3 La = texture(uAerialInscatterS, a).rgb, Lb = texture(uAerialInscatterS, b).rgb;\n"
    "    vec3 T = Ta * pow(max(Tb, vec3(1e-6)) / max(Ta, vec3(1e-6)), vec3(td));\n"
    "    vec3 dT = Ta - Tb;\n"
    "    vec3 w = mix(vec3(td), (Ta - T) / dT, step(vec3(1e-4), abs(dT)));\n"
    "    gh.apL = mix(La, Lb, w) * uSunIlluminance;\n"
    "    gh.apT = T; }\n"
)


# 天顶角方向的插值按「到海平面的同一比例」取：LUT 的每一行在同一距离上，陡的那一行早已打到海面（积分被截在 tBottom），
# 平的那一行还在半空，两者线性混合就是折线（每行一条马赫带）。改成两行各自取「到它自己的海平面交点的同一比例」处，再按行插值
AP_ROWFRAC = (
    "  { float Dy = AERIAL_SIZE.y; float tB = raySphere(ro, rd, BOTTOM);\n"
    "    float yu = (0.5 - 0.5 * sign(rd.y) * sqrt(abs(rd.y))) * (Dy - 1.0);\n"
    "    float k0 = min(floor(yu), Dy - 2.0); float ty = yu - k0;\n"
    "    vec2 hz = normalize(rd.xz + vec2(1e-7, 0.0));\n"
    "    vec3 Ls = vec3(0.0), Tsum = vec3(0.0);\n"
    "    for (int j = 0; j < 2 + uLoopGuard; j++) {\n"
    "      float yk = (k0 + float(j)) / (Dy - 1.0); float c = 1.0 - 2.0 * yk; float vz = sign(c) * c * c;\n"
    "      vec3 rk = vec3(hz.x * sqrt(max(1.0 - vz * vz, 0.0)), vz, hz.y * sqrt(max(1.0 - vz * vz, 0.0)));\n"
    "      float tk = raySphere(ro, rk, BOTTOM);\n"
    "      float dk = (tB > 0.0 && tk > 0.0) ? tT * tk / tB : tT;\n"
    "      vec3 q = vec3(uvw.x, unitToUv(yk, Dy), unitToUv(sqrt(clamp(dk / AERIAL_MAX_DISTANCE, 0.0, 1.0)), AERIAL_SIZE.z));\n"
    "      float wj = j == 0 ? 1.0 - ty : ty;\n"
    "      Ls += wj * texture(uAerialInscatterS, q).rgb; Tsum += wj * texture(uAerialTransmittanceS, q).rgb;\n"
    "    }\n"
    "    gh.apL = Ls * uSunIlluminance; gh.apT = Tsum; }\n"
)


def ap_interp():
    vs = [
        {"name": "cur"},
        {"name": "logZ", **patch([(AP_FETCH, AP_LOGZ)])},
        {"name": "rowFrac", **patch([(AP_FETCH, AP_ROWFRAC)])},
        {"name": "exactAP24", **patch([(GF, EXACT_AP.replace("64.0", "24.0") + GF)])},
    ]
    return [
        job("cruise-ground", vs, crop=[700, 60, 550, 260], extra={"pre": PRE_HAZE}),
        job("hnd-low-day", vs, crop=[400, 400, 800, 600], extra={"pre": PRE_HAZE}),
    ]


SRC_FILES = ["apps/voyage/src/render/outside-pass.ts", "apps/voyage/src/render/terrain-shading.glsl.ts", "apps/voyage/src/render/traffic.glsl.ts"]


def old_patches(which=None):
    """把本分支对 master 的改动按 diff 块反向做成补丁（新 → 旧），old 变体 = 改前着色器。which 过滤文件名片段"""
    import subprocess

    root = HERE.parents[2]
    files = [f for f in SRC_FILES if which is None or any(w in f for w in which)]
    out = subprocess.run(["git", "diff", "master", "-U2", "--", *files], cwd=root, capture_output=True, text=True, encoding="utf-8").stdout
    pairs, new, old, inh = [], [], [], False
    for line in out.splitlines():
        if line.startswith("@@"):
            if inh:
                pairs.append(("".join(new), "".join(old)))
            new, old, inh = [], [], True
            continue
        if not inh or line.startswith(("diff ", "index ", "--- ", "+++ ")):
            if line.startswith("diff ") and inh:
                pairs.append(("".join(new), "".join(old)))
                inh = False
            continue
        body = line[1:] + "\n"
        if line.startswith("+"):
            new.append(body)
        elif line.startswith("-"):
            old.append(body)
        else:
            new.append(body)
            old.append(body)
    if inh:
        pairs.append(("".join(new), "".join(old)))
    return pairs


MASK_G = [(GF, GF + "      L = vec3(5000.0, 0.0, 5000.0);\n"), (REFL, REFL + "      L = vec3(5000.0, 0.0, 5000.0);\n")]
MASK_T = [("      T *= exp(-tau);\n", "      T *= exp(-tau);\n      L = vec3(0.0, 5000.0, 0.0);\n")]


def accept():
    vs = [
        {"name": "old", **patch(old_patches())},
        {"name": "new"},
        {"name": "maskG", **patch(MASK_G)},
        {"name": "maskT", **patch(MASK_T)},
    ]
    jobs = [
        job("hnd-low-day", vs, crop=[400, 400, 800, 300]),
        job("hnd-low-day-26", vs, crop=[400, 400, 800, 300]),
        job("sea-mod-low", vs, crop=[400, 150, 800, 600]),
        job("cruise-ground", vs, crop=[700, 60, 550, 260]),
        job("wpac-cruise", vs, crop=[400, 100, 800, 800]),
    ]
    for sc, dist, dy in (("noon-cu-close", 40, 0.3), ("noon-cumulus", 60, 0.6), ("sunset", 50, 0.3)):
        j = job(sc, vs, crop=[380, 0, 850, 600])
        j["name"] = f"{sc}@{dist}{'+' if dy > 0 else ''}{dy}"
        j["pre"] = traffic_pre(dist, dy, 12)
        jobs.append(j)
    return jobs


def gpu():
    surf = {"name": "reflSurf", **patch([(SKYCAM, SKYCAM_SURF), (OS_REFL, OS_REFL_SURF)])}
    fix = {"name": "fixAP", **patch([(TR_ADD, TR_FIX)])}
    j1 = job("hnd-low-day", [{"name": "cur"}, {"name": "cur2"}, surf])
    j2 = job("sea-mod-low", [{"name": "cur"}, {"name": "cur2"}, surf])
    j3 = job("noon-cumulus", [{"name": "cur"}, {"name": "cur2"}, fix])
    j3["pre"] = traffic_pre(60, 0.6, 12)
    return [j1, j2, j3]


# 暗尾迹：把 0 号飞机摆在窗外正前方 dist km、比我们高 dy km、沿窗面横向飞（尾迹横穿窗口），1 号关掉
def traffic_pre(dist, dy, back):
    return PRE.replace(
        "return 'shown=",
        "const e = v.sceneMat.uniforms.uCabinToWorld.value.elements; "
        "let ox = e[6], oz = e[8]; const ol = Math.hypot(ox, oz); ox /= ol; oz /= ol; "
        "const ax = -oz, az = ox; const P = v.traffic.planes; "
        f"P[0].pos.set(ox * {dist} + ax * {back}, {dy}, oz * {dist} + az * {back}); P[0].dir.set(ax, 0, az); P[0].speed = 0.23; P[0].active = true; P[0].respawnIn = 1e9; "
        "P[1].active = false; P[1].respawnIn = 1e9; "
        "return 'shown=",
    )


TR_ADD = "      L += T * Lc * apT;\n"
TR_FIX = (
    "      L += T * (Lc * apT + texture(uAerialInscatterS, uvw).rgb * uSunIlluminance * (1.0 - exp(-tau)));\n"
)


def diag_contrail():
    vs = [
        {"name": "cur"},
        {"name": "fixAP", **patch([(TR_ADD, TR_FIX)])},
        {"name": "noTraffic", **patch([("    if (tau > 1e-4) {\n", "    tau = 0.0;\n    if (tau > 1e-4) {\n")])},
    ]
    jobs = []
    for sc, dist, dy in (("noon-cu-close", 40, 0.3), ("noon-cumulus", 60, 0.6), ("sunset", 50, 0.3)):
        j = job(sc, vs, crop=[380, 0, 850, 600])
        j["name"] = f"{sc}@{dist}{'+' if dy > 0 else ''}{dy}"
        j["pre"] = traffic_pre(dist, dy, 12)
        jobs.append(j)
    return jobs


GROUPS = {
    "diag-wall": diag_wall,
    "diag-wall2": diag_wall2,
    "diag-stripes": diag_stripes,
    "diag-wall3": diag_wall3,
    "diag-contrail": diag_contrail,
    "diag-stripes2": diag_stripes2,
    "diag-truth": diag_truth,
    "proto": proto,
    "proto2": proto2,
    "diag-stripes3": diag_stripes3,
    "gpu": gpu,
    "ap-interp": ap_interp,
    "accept": accept,
}

if __name__ == "__main__":
    g = sys.argv[1]
    out = HERE / f"SEA-3-{g}-jobs.json"
    out.write_text(json.dumps(GROUPS[g](), ensure_ascii=False, indent=1), encoding="utf-8")
    print(out)
