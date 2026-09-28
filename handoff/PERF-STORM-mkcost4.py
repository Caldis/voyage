"""PERF-STORM 第四轮：乳状云（mammatusDensity / pouchField）为什么占雷暴云步进三成。
用法（apps/voyage 下）：python handoff/PERF-STORM-mkcost4.py
"""
import json
import os
import sys

sys.stdout.reconfigure(encoding="utf-8")
HERE = os.path.dirname(os.path.abspath(__file__))
M = "clouds.marchMat"
SCENES = ["storm-sc-low", "storm-day"]

LOOPU = [["  for (int x = -1; x <= 1; x++)\n  for (int y = -1; y <= 1; y++) {",
          "  for (int x = -1; x <= 1 + min(uStormCount, 0); x++)\n  for (int y = -1; y <= 1 + min(uStormCount, 0); y++) {"]]
ONE = [["  float pd = max(pouchField(xz / 1.4) * 1.4, pouchField(xz / 0.6 + 7.3) * 0.6 * 0.8);",
        "  float pd = pouchField(xz / 1.4) * 1.4;"]]
# 只在「完整密度」里有乳状云；把乳状云整个挪到只在主步进最外层判断（不改几何）：先看调用频度，给 mammatus 计数
NOCL = [["  if (cl <= 0.0) return 0.0;", "  if (cl <= 0.0 || true) return 0.0;"]]

jobs = [{"name": f"c4-{s}", "scene": s, "variants": [
    {"name": "cur"}, {"name": "cur2"},
    {"name": "noMam", "patch": {M: [["  float mam = mammatusDensity(xz, alt, geo);", "  float mam = 0.0;"]]}},
    {"name": "loopU", "patch": {M: LOOPU}},
    {"name": "one", "patch": {M: ONE}},
    {"name": "noPouch", "patch": {M: NOCL}},
]} for s in SCENES]
with open(os.path.join(HERE, "PERF-STORM-cost4-jobs.json"), "w", encoding="utf-8") as f:
    json.dump(jobs, f, ensure_ascii=False, indent=1)
print("ok")
