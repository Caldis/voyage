"""根因定位：雷暴在视野外时近处云海变亮，是不是砧盾外接圆把大批视线划进了 nearW（天气路径）。"""
import json
import sys

out = sys.argv[1]
k = "__Sr"
edge = (
    f"if(!window.{k}) window.{k}=v.weather.storms.map(s=>({{...s}})); const W=v.director.weather; const [px,pz]=W.host.localPos(); let best=null; "
    f"for(let d=0; d<=180; d+=1){{ const a=d*Math.PI/180, c=Math.cos(a), s=Math.sin(a); "
    f"const S=window.{k}.map(q=>{{const dx=q.x-px, dz=q.z-pz; return {{...q, x:px+dx*c-dz*s, z:pz+dx*s+dz*c}};}}); "
    "if(W.outOfView(S.map(q=>({x:q.x,z:q.z,r:q.radius*2.5})))){best={d,S};break;} } "
    "v.weather.storms=best.S; v.weather.syncUniforms(); return 'rot '+best.d;"
)
off = f"if(!window.{k}) window.{k}=v.weather.storms.map(s=>({{...s}})); v.weather.removeStorms(()=>true); v.weather.syncUniforms(); return 0;"
noNear = [["if (cloudRayDist2D(rd, seg, sc.xy) < sc.z) nearAny = true;", "/*rev*/"]]
noK4 = [["if (!(t >= wxSeg.x && t < wxSeg.y) && !(t >= laySeg.x && t < laySeg.y)) emptyK = 4.0;", "/*rev*/"]]
jobs = [{
    "name": "root-storm-sc", "scene": "storm-sc", "crop": [400, 500, 700, 600],
    "variants": [
        {"name": "edge", "js": edge},
        {"name": "edgeNoNear", "js": edge, "patch": {"clouds.marchMat": noNear}},
        {"name": "edgeNoK4", "js": edge, "patch": {"clouds.marchMat": noK4}},
        {"name": "edgeOld", "js": edge, "materials": {"clouds.marchMat": "base"}},
        {"name": "off", "js": off},
    ],
}]
json.dump(jobs, open(out, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
print(out)
