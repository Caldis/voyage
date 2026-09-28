"""PERF-STORM 第二轮诊断：每像素完整雷暴密度 / 精简雷暴密度（受光）求值次数、8 步受光样本数（ab cloudDump 步数通道），
以及按像素区域的 GPU 拆分（gpu-ab：只画雷暴包围柱内 / 外的像素）。
用法（apps/voyage 下）：python handoff/PERF-STORM-mkdiag2.py
"""
import json
import os
import sys

sys.stdout.reconfigure(encoding="utf-8")
HERE = os.path.dirname(os.path.abspath(__file__))
M = "clouds.marchMat"
SCENES = ["storm-sc-low", "storm-day", "typhoon-bands"]

GDECL = ["float gStormW = 0.0;", "float gStormW = 0.0;\nfloat gNS = 0.0; float gNSL = 0.0; float gNL8 = 0.0;"]
NS = ["      float sd = stormDensity(c, xz, alt, lod, detail, ao) * uCloudDensity;",
      "      gNS += 1.0;\n      float sd = stormDensity(c, xz, alt, lod, detail, ao) * uCloudDensity;"]
NSL = ["      d = max(d, stormDensityLite(c, xz, alt, lod) * uCloudDensity);",
       "      gNSL += 1.0; d = max(d, stormDensityLite(c, xz, alt, lod) * uCloudDensity);"]
NL8 = ["      int lightSteps = nearW.x && cloudPointNearWeather(p.xz + uCloudOffset) ? 8 : 6;",
       "      int lightSteps = nearW.x && cloudPointNearWeather(p.xz + uCloudOffset) ? 8 : 6;\n      if (lightSteps == 8) gNL8 += 1.0;"]
# 台风：完整台风密度求值次数也算进 gNS
NH = ["      float hd = hurricaneDensity(xz, alt, lod, detail, hao) * uCloudDensity;",
      "      gNS += 1.0;\n      float hd = hurricaneDensity(xz, alt, lod, detail, hao) * uCloudDensity;"]


def outv(expr):
    return ["  gl_FragColor = vec4(min(L, vec3(60000.0)), T);", f"  iUsed = {expr};\n  gl_FragColor = vec4(min(L, vec3(60000.0)), T);"]


def cnt(name, expr, extra):
    return {"name": name, "builtin": "cloud-steps", "patch": {M: [GDECL] + [[*e, True] for e in extra] + [outv(expr)]}}


diag = [{"name": f"d2-{s}", "scene": s, "cloudDump": {"warm": 96, "frames": 16, "heatTop": 60}, "variants": [
    {"name": "cur"},
    cnt("nsd", "gNS", [NS, NH]),
    cnt("nsl", "gNSL", [NSL]),
    cnt("nl8", "gNL8", [NL8]),
]} for s in SCENES]

HULL_IN = ["    wxSeg = cloudRayWeatherSpan(ro, rd);", "    wxSeg = cloudRayWeatherSpan(ro, rd);\n    if (wxSeg.y < wxSeg.x) return;"]
HULL_OUT = ["    wxSeg = cloudRayWeatherSpan(ro, rd);", "    wxSeg = cloudRayWeatherSpan(ro, rd);\n    if (wxSeg.y >= wxSeg.x) return;"]
NOREFINE_PIX = ["  if (!nearW.x) {\n    if (uCoverage <= 0.0) return;", "  if (!nearW.x) {\n    return;"]
gpu = [{"name": f"g2-{s}", "scene": s, "variants": [
    {"name": "cur"}, {"name": "cur2"},
    {"name": "hullIn", "patch": {M: [HULL_IN]}},
    {"name": "hullOut", "patch": {M: [HULL_OUT]}},
    {"name": "refOnly", "patch": {M: [NOREFINE_PIX]}},
]} for s in SCENES]
with open(os.path.join(HERE, "PERF-STORM-diag2-jobs.json"), "w", encoding="utf-8") as f:
    json.dump(diag, f, ensure_ascii=False, indent=1)
with open(os.path.join(HERE, "PERF-STORM-gpu2-jobs.json"), "w", encoding="utf-8") as f:
    json.dump(gpu, f, ensure_ascii=False, indent=1)
print("ok")
