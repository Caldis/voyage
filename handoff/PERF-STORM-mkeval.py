"""PERF-STORM：交付版 vs master 的画质（ab + cloudDump，对 1/4 步长真值）与 GPU（gpu-ab）job。
用法（apps/voyage 下）：python handoff/PERF-STORM-mkeval.py
需要对照服务器（master）跑在 --base 端口上：ab / gpu-ab 加 --base <端口>。
输出 handoff/PERF-STORM-eval-jobs.json（ab）、handoff/PERF-STORM-gpu-jobs.json（gpu-ab）
"""
import json
import os
import sys

sys.stdout.reconfigure(encoding="utf-8")
HERE = os.path.dirname(os.path.abspath(__file__))

STORM_GRAZE = {"name": "storm-graze", "p": {"preset": "wpac", "date": "2026-09-28", "time": 900, "coverage": 0.6, "altitude": 3.0,
                                              "weather": "storm", "wing-pos": "-4", "quality": "high", "ground-on": False},
               "offset": [0, 0], "wait": 3000}
WX = ["storm-sc-low", "storm-day", "storm-sc", "typhoon-bands", STORM_GRAZE]
CLEAR = ["sea-sc-low", "noon-cumulus"]
M = "clouds.marchMat"
OLD = {M: "base"}


def nm(s):
    return s if isinstance(s, str) else s["name"]


def eval_variants():
    return [
        {"name": "old", "materials": OLD},
        {"name": "cur"},
        {"name": "ref", "builtin": "cloud-ref"},
        {"name": "oldref", "materials": OLD, "builtin": "cloud-ref"},
        {"name": "dist", "builtin": "cloud-dist"},
        {"name": "steps", "builtin": "cloud-steps"},
        {"name": "oldsteps", "materials": OLD, "builtin": "cloud-steps"},
    ]


NOSKIP = ["    if (refineOn && wasEmpty && fine == 0 &&", "    if (false && refineOn && wasEmpty && fine == 0 &&"]


def gpu_variants():
    return [{"name": "old", "materials": OLD}, {"name": "cur"}, {"name": "old2", "materials": OLD},
            {"name": "noskip", "patch": {M: [[*NOSKIP, True]]}}]


ev = [{"name": f"eval-{nm(s)}", "scene": s, "cloudDump": {"warm": 96, "frames": 16, "heatTop": 200}, "variants": eval_variants()} for s in WX]
gp = [{"name": f"gpu-{nm(s)}", "scene": s, "variants": gpu_variants()} for s in WX + CLEAR]
with open(os.path.join(HERE, "PERF-STORM-eval-jobs.json"), "w", encoding="utf-8") as f:
    json.dump(ev, f, ensure_ascii=False, indent=1)
with open(os.path.join(HERE, "PERF-STORM-gpu-jobs.json"), "w", encoding="utf-8") as f:
    json.dump(gp, f, ensure_ascii=False, indent=1)
print("ok", len(ev), len(gp))
