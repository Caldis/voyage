"""PERF-STORM 第八轮：台风云步进的开销拆分（只作定位，关掉某一部分的画面是错的）。
用法（apps/voyage 下）：python handoff/PERF-STORM-mkcost8.py
"""
import json
import os
import sys

sys.stdout.reconfigure(encoding="utf-8")
HERE = os.path.dirname(os.path.abspath(__file__))
M = "clouds.marchMat"

BANDS = ["  if (r > Re * 2.8 && alt < 15.0) {\n    vec4 nB", "  if (false && r > Re * 2.8 && alt < 15.0) {\n    vec4 nB"]
BANDS_L = ["  if (r > Re * 2.8 && alt < 15.0) {\n    // 带子的断续", "  if (false && r > Re * 2.8 && alt < 15.0) {\n    // 带子的断续"]
CANOPY = ["  if (r > Re * 2.5 && alt > 11.0) {", "  if (false && r > Re * 2.5 && alt > 11.0) {"]
EYE = ["  if (r < Re * 4.2) {", "  if (false && r < Re * 4.2) {"]
LIGHT_ANA = ["cloudDensityLite(p + uKeyDir * (lt - 0.5 * ls), lod + 0.5, j < 3, true)", "cloudDensityLite(p + uKeyDir * (lt - 0.5 * ls), lod + 0.5, j < 3, false)"]
NOREF = ["      if (hT < uCloudBottom - 0.3 || hT > uCloudTop + 0.3) emptyK = 2.0;", "      emptyK = 2.0;"]
L6 = ["      int lightSteps = nearW.x && cloudPointNearWeather(p.xz + uCloudOffset) ? 8 : 6;", "      int lightSteps = 6;"]

jobs = [{"name": f"c8-{s}", "scene": s, "variants": [
    {"name": "cur"}, {"name": "cur2"},
    {"name": "bandsOff", "patch": {M: [BANDS]}},
    {"name": "bandsLOff", "patch": {M: [BANDS_L]}},
    {"name": "canopyOff", "patch": {M: [CANOPY]}},
    {"name": "eyeOff", "patch": {M: [EYE]}},
    {"name": "lightAna", "patch": {M: [LIGHT_ANA]}},
    {"name": "noref", "patch": {M: [NOREF]}},
    {"name": "l6", "patch": {M: [L6]}},
]} for s in ["typhoon-bands"]]
with open(os.path.join(HERE, "PERF-STORM-cost8-jobs.json"), "w", encoding="utf-8") as f:
    json.dump(jobs, f, ensure_ascii=False, indent=1)
print("ok")
