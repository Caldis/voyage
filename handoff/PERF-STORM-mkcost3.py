"""PERF-STORM 第三轮开销拆分（gpu-ab）：砧 / 乳状云 / 砧的受光 / 占据网格 mip。
用法（apps/voyage 下）：python handoff/PERF-STORM-mkcost3.py
"""
import json
import os
import sys

sys.stdout.reconfigure(encoding="utf-8")
HERE = os.path.dirname(os.path.abspath(__file__))
M = "clouds.marchMat"
SCENES = ["storm-sc-low", "storm-day", "typhoon-bands"]

NO_ANVIL = ["  float anvil = anvilDensity(xz, alt, c.xy, R, top, lod, aoA, geo);",
            "  float anvil = anvilDensity(xz, alt, c.xy, R, top, lod, aoA, geo);\n  anvil = 0.0;"]
NO_ANVIL_L = ["  return max(max(smoothstep(0.0, 0.25, -sdf), anvilDensity(xz, alt, c.xy, R, top, lod, ao, geo)), rainL);",
              "  return max(smoothstep(0.0, 0.25, -sdf), rainL);"]
NO_MAM = ["  float mam = mammatusDensity(xz, alt, geo);", "  float mam = 0.0;"]
SOFT_L4 = ["      int lightSteps = nearW.x && cloudPointNearWeather(p.xz + uCloudOffset) ? 8 : 6;",
           "      int lightSteps = nearW.x && cloudPointNearWeather(p.xz + uCloudOffset) ? 8 : 6;\n      if (gStormSoft > 0.5 && gStormSoft < 1.5) lightSteps = 4;"]
OCC1 = [{"re": "textureLod\\(uOcc, uvw, 2\\.0\\)", "to": "textureLod(uOcc, uvw, 1.0)"}]
OCC0 = [{"re": "textureLod\\(uOcc, uvw, 2\\.0\\)", "to": "textureLod(uOcc, uvw, 0.0)"}]

jobs = [{"name": f"c3-{s}", "scene": s, "variants": [
    {"name": "cur"}, {"name": "cur2"},
    {"name": "noAnvil", "patch": {M: [[*NO_ANVIL, True]]}},
    {"name": "noAnvilL", "patch": {M: [[*NO_ANVIL_L, True]]}},
    {"name": "noMam", "patch": {M: [[*NO_MAM, True]]}},
    {"name": "softL4", "patch": {M: [SOFT_L4]}},
    {"name": "occ1", "patch": {M: OCC1}},
    {"name": "occ0", "patch": {M: OCC0}},
]} for s in SCENES]
with open(os.path.join(HERE, "PERF-STORM-cost3-jobs.json"), "w", encoding="utf-8") as f:
    json.dump(jobs, f, ensure_ascii=False, indent=1)
print("ok")
