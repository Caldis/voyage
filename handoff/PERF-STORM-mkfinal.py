"""PERF-STORM 交付测量：flight（old / cur / cur2）与切程序一致性（ab cloudDump，storm-sc-low 对 sea-sc-low）。
用法（apps/voyage 下）：python handoff/PERF-STORM-mkfinal.py；对照服务器（master）跑在 --base 端口
"""
import json
import os
import sys

sys.stdout.reconfigure(encoding="utf-8")
HERE = os.path.dirname(os.path.abspath(__file__))
M = "clouds.marchMat"
OLD = {M: "base"}

flight_jobs = [
    {"name": "storm-sc-low", "scene": "storm-sc-low", "offset": [0, 0], "crop": [520, 560, 560, 360]},
    {"name": "storm-sc-low-anvil", "scene": "storm-sc-low", "offset": [0, 0], "crop": [320, 380, 640, 200]},
    {"name": "storm-day", "scene": "storm-day", "offset": [0, 0], "crop": [520, 420, 560, 440]},
]
flight_vars = [{"name": "old", "materials": OLD}, {"name": "cur"}, {"name": "cur2"}]

# 切程序：同一时刻、同一片层积云海，有雷暴（天气程序）与没有雷暴（默认程序）按距离分带的 Y / 真值
sw_jobs = [{"name": f"sw-{s}", "scene": s, "cloudDump": {"warm": 96, "frames": 16}, "variants": [
    {"name": "old", "materials": OLD}, {"name": "cur"},
    {"name": "ref", "builtin": "cloud-ref"}, {"name": "dist", "builtin": "cloud-dist"},
]} for s in ["storm-sc-low", "sea-sc-low", "storm-sc", "sea-sc"]]
STORM_GRAZE = {"name": "storm-graze", "p": {"preset": "wpac", "date": "2026-09-28", "time": 900, "coverage": 0.6, "altitude": 3.0,
                                              "weather": "storm", "wing-pos": "-4", "quality": "high", "ground-on": False},
               "offset": [0, 0], "wait": 3000}
sw_jobs.append({"name": "sw-storm-graze", "scene": STORM_GRAZE, "cloudDump": {"warm": 96, "frames": 16}, "variants": [
    {"name": "old", "materials": OLD}, {"name": "cur"},
    {"name": "ref", "builtin": "cloud-ref"}, {"name": "dist", "builtin": "cloud-dist"},
    {"name": "steps", "builtin": "cloud-steps"}, {"name": "oldsteps", "materials": OLD, "builtin": "cloud-steps"},
]})
for name, obj in [("PERF-STORM-flight-jobs.json", flight_jobs), ("PERF-STORM-flight-variants.json", flight_vars),
                  ("PERF-STORM-sw-jobs.json", sw_jobs)]:
    with open(os.path.join(HERE, name), "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=1)
print("ok")
