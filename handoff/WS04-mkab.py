"""WS04：生成 gpu-ab / ab live 的任务文件（写到仓库根的 tmp/）。
用法：python apps/voyage/handoff/WS04-mkab.py
  tmp/ws04-gpu.json：同页 GPU 计时。变体 big / big2（同代码，A/A 噪声底）/ small（同一页换成小岛版 = W03 原尺寸那条代码路径，
                     同机位同种子）。在场增量 ≈ (big − small) + W03 实测的小岛在场约 0.45 ms。
  tmp/ws04-live.json：飞行中逐帧读回（ab live），big / big2 两次当噪声底。
"""
import json
import os

here = os.path.dirname(os.path.abspath(__file__))
root = os.path.abspath(os.path.join(here, "..", "..", ".."))
scenes = {s["name"]: s for s in json.load(open(os.path.join(here, "WS04-scenes.json"), encoding="utf-8"))}


def summon(wid, dist, seed):
    return (
        "v.wonders.clear(); v.wonders.enabled = true; v.wonders.trigger('%s', { forwardOffsetDeg: 0, distKm: %s, reveal: 1, seed: %s }); "
        "for (let i = 0; i < 240 && v.clouds.wonderLayerState !== 'ready'; i++) await new Promise((r) => setTimeout(r, 250)); "
        "for (let i = 0; i < 8; i++) await new Promise((r) => requestAnimationFrame(r));" % (wid, dist, seed)
    )


gpu = []
for sc, dist in [("ws04-day-110", 110), ("ws04-dusk-110", 110), ("ws04-day-80", 80)]:
    gpu.append({
        "name": sc + "-gpu",
        "scene": scenes[sc],
        "variants": [
            {"name": "big", "js": summon("floatcity", dist, 0.23)},
            {"name": "big2", "js": summon("floatcity", dist, 0.23)},
            {"name": "small", "js": summon("floatcity-small", dist, 0.23)},
        ],
    })
os.makedirs(os.path.join(root, "tmp"), exist_ok=True)
json.dump(gpu, open(os.path.join(root, "tmp", "ws04-gpu.json"), "w", encoding="utf-8", newline="\n"), ensure_ascii=False, indent=1)

live = []
for sc, crop in [("ws04-day-110", [560, 250, 640, 420]), ("ws04-dusk-110", [560, 250, 640, 420])]:
    live.append({
        "name": sc + "-live",
        "scene": scenes[sc],
        "crop": crop,
        "variants": [{"name": "big"}, {"name": "big2"}],
        "live": {
            "crop": crop, "frames": 240, "thr": 16, "frac": 0.05,
            "regions": {"树冠": [180, 40, 300, 110], "台地": [150, 150, 360, 110], "底座根须": [150, 260, 360, 150], "天空": [0, 0, 120, 120]},
        },
    })
json.dump(live, open(os.path.join(root, "tmp", "ws04-live.json"), "w", encoding="utf-8", newline="\n"), ensure_ascii=False, indent=1)
print("ok", root)
