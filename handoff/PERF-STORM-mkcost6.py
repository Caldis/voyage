"""PERF-STORM 第六轮：乳状云的等价剪枝（几何逐位相同）。
 prune：口袋最大下垂深度有上界（pouchField ≤ 1.2，两级合起来 pd ≤ 1.68），采样点离砧底比这个上界还深时
        smoothstep(pb, …, alt) 必为 0，不必算口袋场；
 early：pouchField 里格点中心离采样点 ≥ 0.75 格（口袋最大半径）时跳过第二个哈希；
 skip2：第一级已 ≥ 第二级上界 0.576 时不算第二级。
用法（apps/voyage 下）：python handoff/PERF-STORM-mkcost6.py
"""
import json
import os
import sys

sys.stdout.reconfigure(encoding="utf-8")
HERE = os.path.dirname(os.path.abspath(__file__))
M = "clouds.marchMat"
SCENES = ["storm-sc-low", "storm-day", "storm-sc"]

PRUNE = ["  if (cl <= 0.0) return 0.0;\n", "  if (cl <= 0.0 || aBot + 0.1 - alt >= 1.26 * cl * zone) return 0.0;\n"]
EARLY = ["    vec2 h2 = stormHash22(id + o + 41.7);\n    vec2 fp = o + 0.05 + 0.9 * h - f;\n    float rad = 0.3 + 0.45 * h2.x;\n    float s = 1.0 - dot(fp, fp) / (rad * rad);",
         "    vec2 fp = o + 0.05 + 0.9 * h - f;\n    float d2 = dot(fp, fp);\n    if (d2 >= 0.5625) continue;\n    vec2 h2 = stormHash22(id + o + 41.7);\n    float rad = 0.3 + 0.45 * h2.x;\n    float s = 1.0 - d2 / (rad * rad);"]
SKIP2 = ["  float pd = max(pouchField(xz / 1.4) * 1.4, pouchField(xz / 0.6 + 7.3) * 0.6 * 0.8);",
         "  float pd = pouchField(xz / 1.4) * 1.4;\n  if (pd < 0.576) pd = max(pd, pouchField(xz / 0.6 + 7.3) * 0.6 * 0.8);"]
NOPOUCH = ["  if (cl <= 0.0) return 0.0;", "  if (cl <= 0.0 || true) return 0.0;"]

jobs = [{"name": f"c6-{s}", "scene": s, "variants": [
    {"name": "cur"}, {"name": "cur2"},
    {"name": "prune", "patch": {M: [PRUNE]}},
    {"name": "pe", "patch": {M: [PRUNE, EARLY]}},
    {"name": "pes", "patch": {M: [PRUNE, EARLY, SKIP2]}},
    {"name": "noPouch", "patch": {M: [NOPOUCH]}},
]} for s in SCENES]
with open(os.path.join(HERE, "PERF-STORM-cost6-jobs.json"), "w", encoding="utf-8") as f:
    json.dump(jobs, f, ensure_ascii=False, indent=1)
print("ok")
