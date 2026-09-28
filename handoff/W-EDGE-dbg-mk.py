"""wedge3：静帧读探测段内部量（浮点），看解析覆盖率在小翼前缘为什么偏低。
python mkdbg.py <输出.json> <场景组> <x,y,w,h>"""
import json
import sys

sys.stdout.reconfigure(encoding="utf-8")
import os as _os
ROOT = _os.path.abspath(_os.path.join(_os.path.dirname(__file__), "../../..")).replace("\\", "/") + "/"
allj = json.load(open(_os.environ.get("WEDGE_JOBS", ROOT + "tmp/wedge3/jobs-all.json"), encoding="utf-8"))
out, grp = sys.argv[1], sys.argv[2]
cx, cy, cw, ch = [int(v) for v in sys.argv[3].split(",")]
job = [j for j in allj if j["name"] == grp][0]
V = {v["name"]: v for v in job["variants"]}
M = "wingMat,wingMat.wet"
FINAL = "        float sEdge = (sumD < 0.0 ? min(sumD, -0.5 * n.y * n.x) : sumD) / (pa * (w.t + n.x));"
FOLD = "      } else if (d <= sumD || (sumD < -0.1 * pa * w.t && max(dHit - sumD, d - sumD) > 0.6 * n.y * dS)) {"


def dbg(which):
    if which == "A":
        setv = "gDbg = vec4(sEdge, sumD / (pa * w.t), n.y, (dHit - sumD) / (n.y * dS));"
    else:
        setv = "gDbg = vec4((d - sumD) / (n.y * dS), n.x / (pa * w.t), -0.5 * n.y * n.x / (pa * w.t), float(w.part));"
    return [
        ["bool wingStarved(WingTraceResult w)", "vec4 gDbg = vec4(-9.0);\nbool wingStarved(WingTraceResult w)"],
        [FINAL, FINAL + "\n        if (shadowSteps > 0) " + setv],
        [FOLD, FOLD + "\n        if (shadowSteps > 0) gDbg = vec4(-5.0, sumD / (pa * w.t), max(dHit - sumD, d - sumD) / (n.y * dS), float(w.part));"],
        ["gl_FragColor = sc;\n", "gl_FragColor = vec4(0.0);\n"],
        ["gl_FragColor = vec4(min(col, vec3(uHdrMax)), sc.a);", "gl_FragColor = gDbg;"],
    ]


DUMP = r"""
const H = window.__dxHdr || {};
const out = {};
const W = v.hdrWing.width;
const CX = %d, CY = %d, CW = %d, CH = %d;
const b64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 32768) s += String.fromCharCode.apply(null, u8.subarray(i, i + 32768)); return btoa(s); };
for (const k of ['covRef', 'covNew', 'dbgA', 'dbgB']) {
  const A = H[k]; if (!A) continue;
  const f = new Float32Array(CW * CH * 4);
  for (let y = 0; y < CH; y++) for (let x = 0; x < CW; x++) for (let c = 0; c < 4; c++) f[4 * (y * CW + x) + c] = A[4 * ((CY + y) * W + CX + x) + c];
  out[k] = b64(new Uint8Array(f.buffer));
}
out.crop = [CX, CY, CW, CH];
return out;
""" % (cx, cy, cw, ch)
js = V["new"].get("js", "")
vs = [{"name": "new", "js": js}, V["covNew"], V["covRef"],
      {"name": "dbgA", "patch": {M: dbg("A")}, "js": js}, {"name": "dbgB", "patch": {M: dbg("B")}, "js": js},
      {"name": "dump", "js": js + DUMP}]
json.dump([dict(job, variants=vs)], open(out, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
print(out)
