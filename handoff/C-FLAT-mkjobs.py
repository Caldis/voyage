# 生成「每个变体配自己的 1/4 步长真值」的 ab job（C-FLAT 的颗粒 / 偏差口径）：python C-FLAT-mkjobs.py <输出.json>
import json, sys

OLD = [["const float CLOUD_MS_STEEP = 2.0;", "const float CLOUD_MS_STEEP = 1.0;"], ["mix(1.0, powder, powderW *", "mix(1.0, powder, 0.5 *"]]
MS_LINE = "float msScatter = msDecay * phMs1 * exp(-msK * msDecay * od) + msDecay2 * phMs2 * exp(-msK * msDecay2 * od);"
VARS = {
    "old": OLD,
    "new": [],
    "k15": [["const float CLOUD_MS_STEEP = 2.0;", "const float CLOUD_MS_STEEP = 1.5;"]],
    # 只让平的第 2 阶变陡（b2 0.25 → 0.5），第 1 阶不变
    "k2only": [[MS_LINE, "float msScatter = msDecay * phMs1 * exp(-msDecay * od) + msDecay2 * phMs2 * exp(-msK * msDecay2 * od);"]],
}
SCENES = {
    "noon-cu-close": {"name": "noon-cu-close", "p": {"preset": "wpac", "date": "2026-09-28", "time": 750, "altitude": 3, "coverage": 0.45, "wing-pos": "-4"}},
    "cu-side": {"name": "cu-side", "p": {"preset": "wpac", "date": "2026-09-28", "time": 840, "altitude": 4.5, "coverage": 0.5, "cloud-preset": "towering", "wing-pos": "-4"}},
    "sea-sc": "sea-sc",
}
jobs = []
for sn, sc in SCENES.items():
    vs = []
    for vn, p in VARS.items():
        pa = {"clouds.marchMat": p} if p else None
        a = {"name": vn}
        b = {"name": vn + "ref", "builtin": "cloud-ref"}
        if pa:
            a["patch"] = pa
            b["patch"] = pa
        vs += [a, b]
    vs.append({"name": "dist", "builtin": "cloud-dist"})
    jobs.append({"name": sn, "scene": sc, "cloudDump": {"warm": 96, "frames": 16}, "variants": vs})
json.dump(jobs, open(sys.argv[1], "w", encoding="utf-8"), ensure_ascii=False, indent=1)
