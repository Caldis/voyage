"""最坏情况的摆放 / 移除：单体被转到导演 outOfView 判定的视野边外（圆盘 2.5R），高空风指向窗外视野中心，
看砧盾 / 砧影会不会已经在窗里（导演以为看不见，就会在这一帧硬切出现 / 消失）。两个变体用同一个风，层状云完全相同。"""
import json
import sys

out = sys.argv[1]
jobs = []
for scene, k in [("storm-sc", "__Sw1"), ("storm-day", "__Sw2")]:
    base = (
        f"if(!window.{k}) window.{k}=v.weather.storms.map(s=>({{...s}})); const W=v.director.weather; const [px,pz]=W.host.localPos(); const [ox,oz]=W.outward(); let best=null; "
        f"for(let d=0; d<=180; d+=1){{ const a=d*Math.PI/180, c=Math.cos(a), s=Math.sin(a); "
        f"const S=window.{k}.map(q=>{{const dx=q.x-px, dz=q.z-pz; return {{...q, x:px+dx*c-dz*s, z:pz+dx*s+dz*c}};}}); "
        "if(W.outOfView(S.map(q=>({x:q.x,z:q.z,r:q.radius*2.5})))){best={d,S};break;} } "
        "const q0=best.S[0]; let wx=px+ox*90-q0.x, wz=pz+oz*90-q0.z; const L=Math.hypot(wx,wz); wx/=L; wz/=L; "
        "v.cloudUniforms.uUpperWind.value.set(wx,wz); "
    )
    on = base + "v.weather.storms=best.S; v.weather.syncUniforms(); return 'rot '+best.d+' dist '+Math.hypot(q0.x-px,q0.z-pz).toFixed(0)+' wind '+wx.toFixed(2)+','+wz.toFixed(2);"
    off = base + "v.weather.removeStorms(()=>true); v.weather.syncUniforms(); return 'off';"
    jobs.append({
        "name": f"pop-{scene}", "scene": scene, "crop": [400, 100, 700, 1000],
        "variants": [{"name": "edgeW", "js": on}, {"name": "offW", "js": off}],
    })
json.dump(jobs, open(out, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
print(out)
