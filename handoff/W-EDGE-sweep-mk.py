"""wedge3：冻结后按亚像素步进 head.x 的「确定性运动」序列：每帧 covPath（覆盖率 + 路径码）、covRef、covOld，
只打包裁剪区（全图坐标、自上而下），比 live 录像能逐像素归因。
python mksweep.py <输出.json> <场景组 sun|biz|night> <帧数> <步长 mm> <x,y,w,h> [额外 patch 变体 json：每帧也算它的 cov]"""
import json
import sys

sys.stdout.reconfigure(encoding="utf-8")
import os as _os
ROOT = _os.path.abspath(_os.path.join(_os.path.dirname(__file__), "../../..")).replace("\\", "/") + "/"
allj = json.load(open(_os.environ.get("WEDGE_JOBS", ROOT + "tmp/wedge3/jobs-all.json"), encoding="utf-8"))
pathsrc = open(ROOT + "apps/voyage/handoff/W-EDGE-path-mk.py", encoding="utf-8").read()
PATH = eval(pathsrc.split("PATH = ")[1].split("\nDUMP")[0])
out, grp, N, step = sys.argv[1], sys.argv[2], int(sys.argv[3]), float(sys.argv[4]) / 1000.0
cx, cy, cw, ch = [int(v) for v in sys.argv[5].split(",")]
extra = json.load(open(sys.argv[6], encoding="utf-8")) if len(sys.argv) > 6 else []
job = [j for j in allj if j["name"] == grp][0]
V = {v["name"]: v for v in job["variants"]}
MATS = "wingMat,wingMat.wet"
basejs = V["new"].get("js", "")

PACK = r"""
const H = window.__dxHdr || {};
const acc = (window.__wsAcc ??= {});
const b64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 32768) s += String.fromCharCode.apply(null, u8.subarray(i, i + 32768)); return btoa(s); };
const W = v.hdrWing.width, HH = v.hdrWing.height;
const CX = %d, CY = %d, CW = %d, CH = %d;
const pack = (A, c, scale) => { const u = new Uint8Array(CW * CH); for (let y = 0; y < CH; y++) for (let x = 0; x < CW; x++) { const gy = CY + y, p = 4 * (gy * W + CX + x) + c; u[y * CW + x] = Math.round(Math.min(Math.max(A[p] * scale, 0), 255)); } return b64(u); };
for (const k of Object.keys(H)) {
  const A = H[k];
  if (!A || A.length <= 4) continue;
  if (k.startsWith('c')) {
    acc[k] = pack(A, 0, 255);
    if (k.startsWith('cp')) acc['path_' + k] = pack(A, 1, 16);
  }
  H[k] = new Float32Array(4);
}
acc.crop = [CX, CY, CW, CH];
return %s;
""" % (cx, cy, cw, ch, "%s")

vs = [{"name": "start", "js": basejs}]
REFP = [p for p in V["covRef"]["patch"][MATS]]
OLDM = V["covOld"]["materials"]
COVP = V["covNew"]["patch"][MATS]
for k in range(N):
    hj = basejs + "v.head.x = %.6f; v.head.tx = v.head.x;" % (k * step)
    vs.append({"name": "cp%02d" % k, "patch": {MATS: PATH}, "js": hj})
    vs.append({"name": "cr%02d" % k, "patch": {MATS: REFP}, "uniforms": V["covRef"]["uniforms"], "js": hj})
    vs.append({"name": "co%02d" % k, "materials": OLDM, "patch": {MATS: COVP}, "js": hj})
    for e in extra:
        p = list(e["patch"][MATS]) + COVP
        vs.append({"name": "c%s%02d" % (e["name"], k), "patch": {MATS: p}, "js": hj})
    last = k == N - 1
    vs.append({"name": "dump" if last else "pk%02d" % k, "js": hj + PACK % ("acc" if last else "0")})
json.dump([dict(job, variants=vs)], open(out, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
print(out, len(vs), "变体")
