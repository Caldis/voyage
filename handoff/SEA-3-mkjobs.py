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
    for sc, dist, dy in (("noon-cu-close", 40, 0.3), ("wpac-cruise", 40, 0.6), ("wpac-cruise", 60, -0.3)):
        j = job(sc, vs, crop=[380, 0, 850, 600])
        j["name"] = f"{sc}@{dist}{'+' if dy > 0 else ''}{dy}"
        j["pre"] = traffic_pre(dist, dy, -25)
        jobs.append(j)
    return jobs


GROUPS = {
    "diag-wall": diag_wall,
    "diag-wall2": diag_wall2,
    "diag-stripes": diag_stripes,
    "diag-wall3": diag_wall3,
    "diag-contrail": diag_contrail,
    "diag-stripes2": diag_stripes2,
}

if __name__ == "__main__":
    g = sys.argv[1]
    out = HERE / f"SEA-3-{g}-jobs.json"
    out.write_text(json.dumps(GROUPS[g](), ensure_ascii=False, indent=1), encoding="utf-8")
    print(out)
