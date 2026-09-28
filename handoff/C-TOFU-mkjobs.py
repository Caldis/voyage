# 用法：python C-TOFU-mkjobs.py <输出.json> [额外变体 JSON]，再 dev-browser ab --cloud-live --base <master 端口> --jobs 它；
# 指标：python C-TOFU-metrics.py <ab 输出目录> old,new
# 生成 C-TOFU 的测量 jobs：每个 job 都带 cloudDump，变体 = old/new × (本体, -alt 高度出口, -dist 深度出口, -ref 1/4 步长真值)
import json, sys
ALT = [["  L = L * apT + apL * (1.0 - T);", "  L = vec3(length(ro + rd * depth) - BOTTOM) * (1.0 - T);"]]
OLD = {"materials": {"clouds.marchMat": "base"}}


def vs(full=True, extra=()):
    out = [dict(name="old", **OLD), {"name": "new"}]
    out += list(extra)
    if full:
        out += [dict(name="old-alt", patch={"clouds.marchMat": ALT}, **OLD), {"name": "new-alt", "patch": {"clouds.marchMat": ALT}},
                dict(name="old-dist", builtin="cloud-dist", **OLD), {"name": "new-dist", "builtin": "cloud-dist"}]
    out += [dict(name="old-ref", builtin="cloud-ref", **OLD), {"name": "new-ref", "builtin": "cloud-ref"}]
    return out


jobs = [
    {"name": "cu-6000", "scene": {"name": "v-cu-6000", "p": {"preset": "wpac", "date": "2026-09-28", "time": 900, "altitude": 6, "coverage": 0.35, "wing-pos": "-4"}}, "crop": [390, 520, 820, 180]},
    {"name": "tow-a8", "scene": {"name": "vs-tow-a8", "p": {"preset": "wpac", "date": "2026-09-28", "time": 900, "cloud-preset": "towering", "altitude": 8, "wing-pos": "-4"}}, "crop": [390, 530, 820, 200]},
    {"name": "noon-cumulus", "scene": "noon-cumulus", "crop": [400, 500, 800, 500]},
    {"name": "clouds-variety", "scene": "clouds-variety", "crop": [400, 450, 800, 500]},
    {"name": "cu-side", "scene": {"name": "cu-side", "p": {"preset": "wpac", "date": "2026-09-28", "time": 840, "altitude": 4.5, "coverage": 0.5, "cloud-preset": "towering", "wing-pos": "-4"}}, "crop": [400, 450, 800, 500]},
    {"name": "sea-sc", "scene": "sea-sc", "crop": [400, 450, 800, 500], "full": False},
    {"name": "storm-sc", "scene": "storm-sc", "crop": [400, 450, 800, 500], "full": False},
]
extra = json.loads(sys.argv[2]) if len(sys.argv) > 2 else []
for j in jobs:
    full = j.pop("full", True)
    j["cloudDump"] = True
    j["variants"] = vs(full, extra)
json.dump(jobs, open(sys.argv[1], "w", encoding="utf-8"), ensure_ascii=False, indent=1)
print(sys.argv[1], len(jobs))
