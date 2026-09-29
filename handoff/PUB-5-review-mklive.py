# PUB-5 审查（在含 jobs-all.json 的目录运行：python PUB-5-review-mklive.py live.json）：live 飞行（+ 可选转头）jobs：old/new/old2/new2 录 480 帧，另带 covOld/covNew 冻结覆盖率做轮廓带掩码
import json, sys

base = json.load(open("jobs-all.json", encoding="utf-8"))[0]["variants"]
V = {v["name"]: v for v in base}
HEAD = ("clearInterval(window.__rvI); window.__rvX0 ??= v.head.tx; window.__rvY0 ??= v.head.ty;"
        "window.__rvI = setInterval(() => { const t = performance.now() / 1000;"
        " v.head.tx = window.__rvX0 + 0.03 * Math.sin(t * 1.7); v.head.ty = window.__rvY0 + 0.012 * Math.sin(t * 1.1 + 1); }, 16);")
STOP = "clearInterval(window.__rvI);"


def vs(turn):
    out = []
    for n in ["old", "new", "old2", "new2", "covOld", "covNew"]:
        src = dict(V[n.rstrip("2")])
        src["name"] = n
        src["js"] = (HEAD if turn and not n.startswith("cov") else STOP)
        out.append(src)
    return out


CROP = [400, 480, 440, 420]
REG = {"内整流罩": [30, 300, 190, 100], "中整流罩": [260, 110, 120, 100], "外整流罩": [340, 20, 90, 110]}
jobs = []
for name, scene, turn in [("noon", "noon-cumulus", False), ("sun", "sunset-wing", False), ("hnd", "route-hnd-cts", False),
                          ("sun-turn", "sunset-wing", True), ("hnd-turn", "route-hnd-cts", True)]:
    jobs.append({"name": name, "scene": scene, "variants": vs(turn),
                 "live": {"crop": CROP, "frames": 480, "variants": ["old", "new", "old2", "new2"], "regions": REG, "thr": 8, "frac": 0.05}})
json.dump(jobs, open(sys.argv[1], "w", encoding="utf-8"), ensure_ascii=False, indent=1)
print(len(jobs), "jobs")
