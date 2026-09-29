"""雷暴撤走以后云海多久恢复：orig → off（等 30 帧）→ orig → off 再等 3 s / 8 s。区域取近处云海。"""
import json
import sys

out = sys.argv[1]
jobs = []
for scene, k in [("storm-sc", "__Sc3"), ("storm-sc-low", "__Scl3")]:
    orig = f"if(!window.{k}) window.{k}=v.weather.storms.map(s=>({{...s}})); v.weather.storms=window.{k}.map(s=>({{...s}})); v.weather.syncUniforms(); return 1;"

    def off(ms):
        return f"if(!window.{k}) window.{k}=v.weather.storms.map(s=>({{...s}})); v.weather.removeStorms(()=>true); v.weather.syncUniforms(); await new Promise(r=>setTimeout(r,{ms})); return {ms};"

    jobs.append({
        "name": f"lag-{scene}", "scene": scene, "crop": [400, 500, 700, 600],
        "variants": [
            {"name": "orig", "js": orig},
            {"name": "off0", "js": off(0)},
            {"name": "orig2", "js": orig},
            {"name": "off3s", "js": off(3000)},
            {"name": "orig3", "js": orig},
            {"name": "off8s", "js": off(8000)},
        ],
    })
json.dump(jobs, open(out, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
print(out)
