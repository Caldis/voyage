# WX11g-b：生成 ab 的 jobs（同页 old / new / noglint × 风速档），old 变体 = 把当前耀斑闪点段换回 master 的原文。
# 低空海面（< 4 km）画的是窗外的低空细节变体（GroundDetailVariant 的另一个材质对象），换 outsideMat 碰不到它：
# job.pre 等变体编好，把实际画的材质挂到 __voyage.__outCur，变体的 patch 改它。
# 用法（仓库根）：python apps/voyage/handoff/WX11g-b-mkjobs.py
import json
import os
import subprocess
import sys

sys.stdout.reconfigure(encoding="utf-8")
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
SRC = "apps/voyage/src/render/ocean.glsl.ts"
HERE = os.path.join(ROOT, "apps/voyage/handoff")
BASE_REV = sys.argv[1] if len(sys.argv) > 1 else "530c8cb"  # 改动前的 master


def block(text: str) -> str:
    a = text.index("    // 波光粼粼")
    b = text.index("    L += eSun * fresnelWater(dot(v, hv)) * p")
    return text[a:b]


cur = open(os.path.join(ROOT, SRC), encoding="utf-8").read()
old = subprocess.run(["git", "-C", ROOT, "show", f"{BASE_REV}:{SRC}"], capture_output=True, encoding="utf-8", check=True).stdout
NEW_B, OLD_B = block(cur), block(old)
assert NEW_B != OLD_B
# 模板字符串里的反斜杠：ocean.glsl.ts 是 JS 模板字符串，原文里没有转义序列，着色器文本与文件文本一致
MARK = "L += eSun * fresnelWater(dot(v, hv)) * p / (4.0 * cosV * cb2 * cb2) * sparkle;"
assert MARK in cur

PRE = (
    "for (let i = 0; i < 1200 && v.groundDetail.pending; i++) await new Promise((r) => requestAnimationFrame(r));"
    " const k = v.groundDetail.shown; v.__outCur = k ? v.groundDetail.variants.get(k).material : v.outsideMat;"
    " return 'shown=' + JSON.stringify(k);"
)


def wind_js(w):
    return (
        f"v.state.wind = {w}; for (let i = 0; i < 600 && v.ocean.stats.wind !== {w}; i++) await new Promise((r) => requestAnimationFrame(r));"
        " return v.ocean.stats.wind;"
    )


WINDS = [0, 1.5, 3, 7, 14]


def static_variants(winds):
    out = []
    for w in winds:
        out.append({"name": f"old{w}", "patch": {"__outCur": [[NEW_B, OLD_B]]}, "js": wind_js(w)})
        out.append({"name": f"new{w}", "js": wind_js(w)})
        out.append({"name": f"noglint{w}", "patch": {"__outCur": [[MARK, MARK.replace("* sparkle;", "* 0.0;")]]}, "js": wind_js(w)})
    return out


scenes = [
    {"name": "low-sea-glint", "scene": "low-sea-glint"},
    {"name": "sea-calm-low", "scene": {"name": "sea-calm-low", "p": {"preset": "wpac", "date": "2026-09-28", "time": 870, "coverage": 0.1, "altitude": 0.8, "wind": 1.5, "wing-pos": "-4"}}},
]
jobs = [dict(s, pre=PRE, variants=static_variants(WINDS)) for s in scenes]
json.dump(jobs, open(os.path.join(HERE, "WX11g-b-ab-jobs.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)

# 飞行中逐帧（ab live）：每个风速 old / new / new 第二次（同代码噪声底）
LIVE_CROP = [400, 560, 800, 540]
live_jobs = []
for w in [1.5, 7, 14]:
    for s in scenes[:1] + ([scenes[1]] if w == 1.5 else []):
        live_jobs.append({
            "name": f"{s['name']}-live-w{w}",
            "scene": s["scene"],
            "pre": PRE,
            "variants": [
                {"name": "old", "patch": {"__outCur": [[NEW_B, OLD_B]]}, "js": wind_js(w)},
                {"name": "new", "js": wind_js(w)},
                {"name": "new2", "js": wind_js(w)},
            ],
            "live": {"crop": LIVE_CROP, "frames": 240, "settle": 10, "thr": 16, "frac": 0.05},
        })
json.dump(live_jobs, open(os.path.join(HERE, "WX11g-b-live-jobs.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)

# gpu-ab：整帧，old / new / new 的 A/A
gpu_jobs = []
for s in scenes:
    gpu_jobs.append({
        "name": f"{s['name']}-frame",
        "scene": s["scene"],
        "pre": PRE,
        "variants": [
            {"name": "old", "patch": {"__outCur": [[NEW_B, OLD_B]]}, "js": wind_js(1.5)},
            {"name": "new", "js": wind_js(1.5)},
            {"name": "new-AA", "js": wind_js(1.5)},
        ],
    })
json.dump(gpu_jobs, open(os.path.join(HERE, "WX11g-b-gpu-jobs.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
print("写好 WX11g-b-ab-jobs.json / WX11g-b-live-jobs.json / WX11g-b-gpu-jobs.json")
