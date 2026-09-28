"""PERF-STORM 第九轮：台风雨带的等价快写法（几何逐位相同）。
 early：单体循环里 coreC 必为 0 的格子（h2.x < 0.25、格心离台风中心 ≤ 3Re 或 ≥ 16Re）在算相位（log / cos / 除法）之前跳过
 cellG：受光版雨带每一步都按 gHurCell 重算 3 个哈希、塔心、塔高、塔半径（一次受光步进 8 步都一样）；改成完整版记录时一并存下
用法（apps/voyage 下）：python handoff/PERF-STORM-mkcost9.py
"""
import json
import os
import sys

sys.stdout.reconfigure(encoding="utf-8")
HERE = os.path.dirname(os.path.abspath(__file__))
M = "clouds.marchMat"

EARLY = ["        vec2 h2 = stormHash22(id * 1.7 + 3.1);\n        vec2 hc = c - uHurricane.xy;\n        float rcc = length(hc);\n",
         "        vec2 h2 = stormHash22(id * 1.7 + 3.1);\n        if (h2.x < 0.25) continue;\n        vec2 hc = c - uHurricane.xy;\n        float rcc = length(hc);\n        if (rcc <= Re * 3.0 || rcc >= Re * 16.0) continue;\n"]

G_DECL = ["vec3 gHurCell = vec3(0.0);\n", "vec3 gHurCell = vec3(0.0);\nvec4 gHurCellP = vec4(0.0);   // 记录那座塔的 (塔心 xy, Ht, Rt)\nvec2 gHurCellH3 = vec2(0.0);\n"]
G_SET = ["        if (sd < sdf) gHurCell = vec3(id, coreC);\n",
         "        if (sd < sdf) { gHurCell = vec3(id, coreC); gHurCellP = vec4(c, Ht, Rt); gHurCellH3 = h3; }\n"]
G_USE_OLD = """        vec2 h1 = stormHash22(bc.xy + 17.3);
        vec2 h2 = stormHash22(bc.xy * 1.7 + 3.1);
        vec2 h3 = stormHash22(bc.xy * 2.3 + 7.9);
        vec2 c = (bc.xy + 0.2 + 0.6 * h1) * CELL;
        float rcc = length(c - uHurricane.xy);
        float coreC = bc.z;
        float topMax = mix(13.0, 8.5, smoothstep(Re * 3.5, Re * 15.0, rcc));
        float Ht = 2.0 + (mix(5.0, topMax, h2.y * (1.3 - 0.3 * h2.y)) - 2.0) * mix(0.55, 1.0, coreC);
        float Rt = CELL * (0.22 + 0.24 * h1.x) * mix(0.75, 1.0, coreC);
"""
G_USE_NEW = """        vec2 h3 = gHurCellH3;
        vec2 c = gHurCellP.xy;
        float Ht = gHurCellP.z;
        float Rt = gHurCellP.w;
"""
CELLG = [G_DECL, G_SET, [G_USE_OLD, G_USE_NEW]]

jobs = [{"name": "c9-typhoon-bands", "scene": "typhoon-bands", "variants": [
    {"name": "cur"}, {"name": "cur2"},
    {"name": "early", "patch": {M: [EARLY]}},
    {"name": "cellG", "patch": {M: CELLG}},
    {"name": "both", "patch": {M: [EARLY] + CELLG}},
]}]
with open(os.path.join(HERE, "PERF-STORM-cost9-jobs.json"), "w", encoding="utf-8") as f:
    json.dump(jobs, f, ensure_ascii=False, indent=1)
print("ok")
