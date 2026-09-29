"""PUB-5：襟翼滑轨整流罩轮廓的同页 A/B jobs（复用 W-EDGE-mkjobs.py 的参考图 / 覆盖率读回 / dump）。

变体：old（对照端口 master 原文）、new（本分支当前代码）、PUB-5 的候选补丁（每个配一个 cov<名> 覆盖率读回）、ref、covOld、covNew、covRef、dump。
候选补丁相对 master 的 wing.glsl.ts（本分支改完以后 new 就是其中一个候选，补丁找不到原文时 ab 会报错——那时改用 --no-cand）。
用法：python handoff/PUB-5-mkjobs.py <输出 jobs.json> [场景组 all|noon|sun|hnd|night] [--no-cand]
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
src = open(os.path.join(HERE, "W-EDGE-mkjobs.py"), encoding="utf-8").read()
ns = {"__name__": "wedge_mkjobs"}
exec(src[: src.rindex("\nmain()")], ns)
MATS, BASE, REF_PATCH, REF_UNI, DUMP_JS, cov_patch = ns["MATS"], ns["BASE"], ns["REF_PATCH"], ns["REF_UNI"], ns["DUMP_JS"], ns["cov_patch"]

# ---- 候选补丁 ----
CANOE_OLD = """  vec2 q = vec2(zRel / wz, (yRel - yc) / hy);
  float d = (length(q) - 1.0) * min(wz, hy);
  return max(d, max(-u, u - 1.0) * len);"""
# 椭圆距离取一阶精确（f / |∇f|）；尾端 / 头端平切面按「截面 × 轴向」挤出体的精确组合（棱外是到棱的距离，不是 max）
CANOE_ELL = """  vec2 er = vec2(wz, hy);
  vec2 ep = vec2(zRel, yRel - yc);
  float k0 = length(ep / er);
  float d = (k0 - 1.0) / max(length(ep / (er * er)) / max(k0, 1e-6), 1.0 / max(wz, hy));
  float e = max(-u, u - 1.0) * len;
  return min(max(d, e), 0.0) + length(max(vec2(d, e), 0.0));"""
# 只修椭圆、端面仍取 max
CANOE_ELLMAX = """  vec2 er = vec2(wz, hy);
  vec2 ep = vec2(zRel, yRel - yc);
  float k0 = length(ep / er);
  float d = (k0 - 1.0) / max(length(ep / (er * er)) / max(k0, 1e-6), 1.0 / max(wz, hy));
  return max(d, max(-u, u - 1.0) * len);"""
RGSS = "        else if (w.part == 5) { w.edge = true; phase = 2; }\n"
P_ELL = [[CANOE_OLD, CANOE_ELL]]
P_ELLMAX = [[CANOE_OLD, CANOE_ELLMAX]]
P_NORGSS = [[RGSS, ""]]

CANDS = {
    "ell": P_ELL,                 # 距离场修正，整流罩内侧仍走 RGSS
    "ella": P_ELL + P_NORGSS,     # 距离场修正 + 整流罩内侧也走解析覆盖率（与其他部件统一）
    "ellm": P_ELLMAX + P_NORGSS,  # 只修椭圆、端面 max + 内侧解析
}


def variants(strobe, cands):
    js = "v.wingDebug.strobe = 1;" if strobe else ""
    vs = [{"name": "old", "materials": BASE, "js": js}, {"name": "new", "js": js}]
    for n, p in cands.items():
        vs.append({"name": n, "patch": {MATS: p}, "js": js})
    vs.append({"name": "ref", "patch": {MATS: REF_PATCH}, "uniforms": REF_UNI, "js": js})
    vs.append({"name": "covOld", "materials": BASE, "patch": {MATS: cov_patch(False)}, "js": js})
    vs.append({"name": "covNew", "patch": {MATS: cov_patch(False)}, "js": js})
    for n, p in cands.items():
        vs.append({"name": "cov" + n[0].upper() + n[1:], "patch": {MATS: p + cov_patch(False)}, "js": js})
    vs.append({"name": "covRef", "patch": {MATS: REF_PATCH + cov_patch(True)}, "uniforms": REF_UNI, "js": js})
    vs.append({"name": "dump", "js": js + DUMP_JS})
    return vs


NIGHT = {"name": "night-wing-on", "p": {"preset": "wpac", "date": "2026-01-16", "time": 1320, "coverage": 0.15, "cabin-light": True, "wing-pos": "8"}}


def main():
    out = sys.argv[1]
    group = sys.argv[2] if len(sys.argv) > 2 and not sys.argv[2].startswith("--") else "all"
    cands = {} if "--no-cand" in sys.argv else CANDS
    jobs = []
    if group in ("all", "noon"):
        jobs.append({"name": "noon", "scene": "noon-cumulus", "hdr": "hdrWing", "variants": variants(False, cands)})
    if group in ("all", "sun"):
        jobs.append({"name": "sun", "scene": "sunset-wing", "hdr": "hdrWing", "variants": variants(False, cands)})
    if group in ("all", "hnd"):
        jobs.append({"name": "hnd", "scene": "route-hnd-cts", "hdr": "hdrWing", "variants": variants(False, cands)})
    if group in ("all", "night"):
        jobs.append({"name": "night", "scene": NIGHT, "hdr": "hdrWing", "variants": variants(True, cands)})
    with open(out, "w", encoding="utf-8") as f:
        json.dump(jobs, f, ensure_ascii=False, indent=1)
    print(out, len(jobs), "jobs")


main()
