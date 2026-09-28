"""PERF-STORM：生成 ab（步数 / 受光 / 深度诊断）与 gpu-ab（开销拆分）的 job 文件。
用法（apps/voyage 下）：python handoff/PERF-STORM-mkjobs.py
输出 handoff/PERF-STORM-diag-jobs.json、handoff/PERF-STORM-cost-jobs.json
"""
import json
import os
import sys

sys.stdout.reconfigure(encoding="utf-8")
HERE = os.path.dirname(os.path.abspath(__file__))

STORM_GRAZE = {"name": "storm-graze", "p": {"preset": "wpac", "date": "2026-09-28", "time": 900, "coverage": 0.6, "altitude": 3.0,
                                              "weather": "storm", "wing-pos": "-4", "quality": "high", "ground-on": False},
               "offset": [0, 0], "wait": 3000}
SCENES = ["storm-sc-low", "storm-day", "typhoon-bands", "storm-sc", STORM_GRAZE]

M = "clouds.marchMat"
DECL = ["  bool wasEmpty = true;\n", "  bool wasEmpty = true;\n  float nLit = 0.0; float nOut = 0.0; float nIn = 0.0;\n"]


def out_var(expr):
    # 在最终输出前把计数写进 iUsed（cloud-steps 内置变体随后把输出换成 iUsed）
    return ["  gl_FragColor = vec4(min(L, vec3(60000.0)), T);", f"  iUsed = {expr};\n  gl_FragColor = vec4(min(L, vec3(60000.0)), T);"]


LIT = ["      float sigma = dens * CLOUD_EXTINCTION;", "      nLit += 1.0;\n      float sigma = dens * CLOUD_EXTINCTION;"]
OUT = ["      if (hT < uCloudBottom - 0.3 || hT > uCloudTop + 0.3) emptyK = 2.0;",
       "      if (hT < uCloudBottom - 0.3 || hT > uCloudTop + 0.3) { emptyK = 2.0; nOut += 1.0; }"]
IN = ["    float dt = fine > 0 ? fineDt : dtBase;", "    if (emptyK < 1.99) nIn += 1.0;\n    float dt = fine > 0 ? fineDt : dtBase;"]


def diag_variants():
    return [
        {"name": "cur"},
        {"name": "steps", "builtin": "cloud-steps"},
        {"name": "lit", "builtin": "cloud-steps", "patch": {M: [DECL, LIT, out_var("nLit")]}},
        {"name": "out", "builtin": "cloud-steps", "patch": {M: [DECL, OUT, out_var("nOut")]}},
        {"name": "in", "builtin": "cloud-steps", "patch": {M: [DECL, IN, out_var("nIn")]}},
        {"name": "tend", "builtin": "cloud-steps", "patch": {M: [out_var("t")]}},
        {"name": "dist", "builtin": "cloud-dist"},
    ]


NOREF = ["      if (hT < uCloudBottom - 0.3 || hT > uCloudTop + 0.3) emptyK = 2.0;", "      emptyK = 2.0;"]
L6 = ["      int lightSteps = nearW.x && cloudPointNearWeather(p.xz + uCloudOffset) ? 8 : 6;", "      int lightSteps = 6;"]
NOL = ["      int lightSteps = nearW.x && cloudPointNearWeather(p.xz + uCloudOffset) ? 8 : 6;", "      int lightSteps = 0;"]
LAYONLY = ["  if (!nearW.x) {\n    if (uCoverage <= 0.0) return;", "  if (true) {\n    if (uCoverage <= 0.0) return;"]


def cost_variants():
    return [
        {"name": "cur"},
        {"name": "cur2"},
        {"name": "noref", "patch": {M: [NOREF]}},
        {"name": "l6", "patch": {M: [L6]}},
        {"name": "nol", "patch": {M: [NOL]}},
        {"name": "layonly", "patch": {M: [LAYONLY]}},
    ]


def nm(s):
    return s if isinstance(s, str) else s["name"]


diag = [{"name": f"diag-{nm(s)}", "scene": s, "cloudDump": {"warm": 96, "frames": 16, "heatTop": 200}, "variants": diag_variants()} for s in SCENES]
cost = [{"name": f"cost-{nm(s)}", "scene": s, "variants": cost_variants()} for s in SCENES]
with open(os.path.join(HERE, "PERF-STORM-diag-jobs.json"), "w", encoding="utf-8") as f:
    json.dump(diag, f, ensure_ascii=False, indent=1)
with open(os.path.join(HERE, "PERF-STORM-cost-jobs.json"), "w", encoding="utf-8") as f:
    json.dump(cost, f, ensure_ascii=False, indent=1)
print("ok", len(diag), len(cost))
