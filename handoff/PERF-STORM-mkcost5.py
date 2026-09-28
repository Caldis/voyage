"""PERF-STORM 第五轮：乳状云口袋场 pouchField 的等价快写法（几何逐位相同）。
用法（apps/voyage 下）：python handoff/PERF-STORM-mkcost5.py
"""
import json
import os
import sys

sys.stdout.reconfigure(encoding="utf-8")
HERE = os.path.dirname(os.path.abspath(__file__))
M = "clouds.marchMat"
SCENES = ["storm-sc-low", "storm-day", "storm-sc"]

OLD_BODY = """  for (int x = -1; x <= 1; x++)
  for (int y = -1; y <= 1; y++) {
    vec2 o = vec2(float(x), float(y));
    vec2 h = stormHash22(id + o);
    vec2 h2 = stormHash22(id + o + 41.7);
    vec2 fp = o + 0.05 + 0.9 * h - f;
    float rad = 0.3 + 0.45 * h2.x;
    float s = 1.0 - dot(fp, fp) / (rad * rad);
    if (s > 0.0 && h2.y > 0.25) best = max(best, (0.4 + 1.2 * h2.y * h2.y) * rad * sqrt(s));
  }"""


def body(loop_u, early):
    b = "+ min(uStormCount, 0)" if loop_u else ""
    lines = [f"  for (int x = -1; x <= 1 {b}; x++)".replace("  ;", ";").replace(" ;", ";"),
             f"  for (int y = -1; y <= 1 {b}; y++) {{".replace(" ;", ";"),
             "    vec2 o = vec2(float(x), float(y));",
             "    vec2 h = stormHash22(id + o);",
             "    vec2 fp = o + 0.05 + 0.9 * h - f;",
             "    float d2 = dot(fp, fp);"]
    if early:
        lines.append("    if (d2 >= 0.5625) continue;")
    lines += ["    vec2 h2 = stormHash22(id + o + 41.7);",
              "    float rad = 0.3 + 0.45 * h2.x;",
              "    float s = 1.0 - d2 / (rad * rad);",
              "    if (s > 0.0 && h2.y > 0.25) best = max(best, (0.4 + 1.2 * h2.y * h2.y) * rad * sqrt(s));",
              "  }"]
    return "\n".join(lines)


def var(name, loop_u, early):
    return {"name": name, "patch": {M: [[OLD_BODY, body(loop_u, early)]]}}


jobs = [{"name": f"c5-{s}", "scene": s, "variants": [
    {"name": "cur"}, {"name": "cur2"},
    var("same", False, False),
    var("early", False, True),
    var("loopU", True, False),
    var("loopUe", True, True),
    {"name": "noPouch", "patch": {M: [["  if (cl <= 0.0) return 0.0;", "  if (cl <= 0.0 || true) return 0.0;"]]}},
]} for s in SCENES]
with open(os.path.join(HERE, "PERF-STORM-cost5-jobs.json"), "w", encoding="utf-8") as f:
    json.dump(jobs, f, ensure_ascii=False, indent=1)
print(body(True, True))
