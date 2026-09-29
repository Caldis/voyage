"""生成 TW04 审查的「有无雷暴切换」ab 作业：orig / off / edgeP / edgeM（把雷暴绕相机转到导演 outOfView 判定的视野边外）。"""
import json
import sys

out = sys.argv[1]


def orig(k):
    return f"if(!window.{k}) window.{k}=v.weather.storms.map(s=>({{...s}})); v.weather.storms=window.{k}.map(s=>({{...s}})); v.weather.syncUniforms(); return v.weather.storms.length;"


def off(k):
    return f"if(!window.{k}) window.{k}=v.weather.storms.map(s=>({{...s}})); v.weather.removeStorms(()=>true); v.weather.syncUniforms(); return v.weather.storms.length;"


def edge(k, sg):
    return (
        f"if(!window.{k}) window.{k}=v.weather.storms.map(s=>({{...s}})); const W=v.director.weather; const [px,pz]=W.host.localPos(); let best=null; "
        f"for(let d=0; d<=180; d+=1){{ const a={sg}*d*Math.PI/180, c=Math.cos(a), s=Math.sin(a); "
        f"const S=window.{k}.map(q=>{{const dx=q.x-px, dz=q.z-pz; return {{...q, x:px+dx*c-dz*s, z:pz+dx*s+dz*c}};}}); "
        "if(W.outOfView(S.map(q=>({x:q.x,z:q.z,r:q.radius*2.5})))){best={d,S};break;} } "
        "v.weather.storms=best.S; v.weather.syncUniforms(); return 'rot '+best.d+' n '+best.S.length;"
    )


jobs = []
for name, scene, k in [("sw-storm-day", "storm-day", "__Sd"), ("sw-storm-sc", "storm-sc", "__Ssc"), ("sw-storm-sc-low", "storm-sc-low", "__Sscl")]:
    jobs.append({
        "name": name, "scene": scene, "crop": [380, 0, 840, 1180],
        "variants": [
            {"name": "orig", "js": orig(k)},
            {"name": "off", "js": off(k)},
            {"name": "edgeP", "js": edge(k, 1)},
            {"name": "edgeM", "js": edge(k, -1)},
        ],
    })
json.dump(jobs, open(out, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
print(out)
