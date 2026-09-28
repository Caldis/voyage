import json
root = "D:/Code/opus-test/.claude/worktrees/agent-a244e5bef012ec606/"
scenes = {s["name"]: s for s in json.load(open(root + "apps/voyage/handoff/WS02-scenes.json", encoding="utf-8"))}
M = "clouds.wonderSurfMat"
OLDBOX = {M + ".uniforms.uWonderBoxMin.value": [-36, 0, -36], M + ".uniforms.uWonderBoxMax.value": [36, 7, 36]}
empty_js = "const d = v.wonders.active.def; d.volume = Object.assign({}, d.volume, { kind: 0 }); for (let i = 0; i < 6; i++) await new Promise((r) => requestAnimationFrame(r));"
restore_js = "const d = v.wonders.active.def; if (d.volume.kind === 0) d.volume = Object.assign({}, d.volume, { kind: 2 }); for (let i = 0; i < 6; i++) await new Promise((r) => requestAnimationFrame(r));"

# GPU：同页计时（clouds = 奇观 pass + 云步进 + resolve）
gpu = []
for sc in ["ws02-night-110", "ws02-night-95", "ws02-dusk"]:
    gpu.append({
        "name": sc + "-gpu",
        "scene": scenes[sc],
        "variants": [
            {"name": "cur", "js": restore_js},
            {"name": "cur2", "js": restore_js},
            {"name": "master", "js": restore_js, "materials": {M: "base"}, "uniforms": OLDBOX},

        ],
    })
json.dump(gpu, open(root + "tmp/ws02-gpu.json", "w", encoding="utf-8"), ensure_ascii=False, indent=1)

# 闪烁：飞行中逐帧读回（ab live），同代码两次当噪声底，master 对照
live = []
for sc, crop in [("ws02-night-110", [560, 360, 600, 340]), ("ws02-dusk", [560, 360, 600, 340])]:
    live.append({
        "name": sc + "-live",
        "scene": scenes[sc],
        "crop": crop,
        "variants": [{"name": "cur"}, {"name": "cur2"}, {"name": "master", "materials": {M: "base"}, "uniforms": OLDBOX}],
        "live": {
            "crop": crop, "frames": 240, "thr": 16, "frac": 0.05,
            "regions": {"塔群": [150, 20, 300, 260], "雾盘近边": [0, 250, 600, 90], "天空": [0, 0, 150, 200]},
        },
    })
json.dump(live, open(root + "tmp/ws02-live.json", "w", encoding="utf-8"), ensure_ascii=False, indent=1)
print("ok")
