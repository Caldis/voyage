"""PERF-STORM 第十轮：天气受光步进（8 步那支）在受光样本升出外壳顶以后提前结束（结果逐位不变：
太阳在本点地平以上时沿太阳方向高度单调上升，出了外壳顶 cloudDensityLite 恒为 0）。
用法（apps/voyage 下）：python handoff/PERF-STORM-mkcost10.py
"""
import json
import os
import sys

sys.stdout.reconfigure(encoding="utf-8")
HERE = os.path.dirname(os.path.abspath(__file__))
M = "clouds.marchMat"

OLD = "        for (int j = 0; j < lightSteps; j++) {\n          lt += ls;\n"
NEW = ("        bool sunUp = dot(uKeyDir, up) > 0.0;\n"
       "        for (int j = 0; j < lightSteps; j++) {\n"
       "          if (sunUp && length(p + uKeyDir * lt) - BOTTOM > uShellTop) { if (j <= 2) odNearW = od; break; }\n"
       "          lt += ls;\n")
jobs = [{"name": f"c10-{s}", "scene": s, "variants": [
    {"name": "cur"}, {"name": "cur2"},
    {"name": "lbrk", "patch": {M: [[OLD, NEW]]}},
]} for s in ["storm-sc-low", "storm-day", "typhoon-bands"]]
with open(os.path.join(HERE, "PERF-STORM-cost10-jobs.json"), "w", encoding="utf-8") as f:
    json.dump(jobs, f, ensure_ascii=False, indent=1)
print("ok")
