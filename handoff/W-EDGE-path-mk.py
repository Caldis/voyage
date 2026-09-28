"""wedge3：静帧诊断——每个像素的外轮廓走哪条路（gEdgePath），和 covNew / covRef 一起打包。
python mkpath.py <输出.json> <场景组 sun|biz|night> [N 轮 head 微移]"""
import json
import sys

sys.stdout.reconfigure(encoding="utf-8")
import os as _os
ROOT = _os.path.abspath(_os.path.join(_os.path.dirname(__file__), "../../..")).replace("\\", "/") + "/"
allj = json.load(open(_os.environ.get("WEDGE_JOBS", ROOT + "tmp/wedge3/jobs-all.json"), encoding="utf-8"))
out, grp = sys.argv[1], sys.argv[2]
job = [j for j in allj if j["name"] == grp][0]
V = {v["name"]: v for v in job["variants"]}
MATS = "wingMat,wingMat.wet"
PATH = [
    ["bool wingStarved(WingTraceResult w)", "float gEdgePath = 0.0;\nfloat gNdv = 0.0;\nfloat gSil = 0.0;\nbool wingStarved(WingTraceResult w)"],
    ["w.cov = best < 0.7072 ? 3.0 + best : 0.0;", "w.cov = best < 0.7072 ? 3.0 + best : 0.0; if (shadowSteps > 0) gEdgePath = 1.0;"],
    ["          phase = 3;\n", "          phase = 3; gEdgePath = 6.0;\n"],
    ["        phase = 2;\n      } else {\n        // 深度另取几何估计", "        phase = 2; gEdgePath = 3.0;\n      } else {\n        // 深度另取几何估计"],
    ["        w.tGraze = -2.0;\n        phase = 2;\n      } else if (d <= sumD && n.z < 12.0)", "        w.tGraze = -2.0; gEdgePath = 4.0;\n        phase = 2;\n      } else if (d <= sumD && n.z < 12.0)"],
    ["if (sEdge < -0.7072) { w.tGraze = -2.0; phase = 2; }", "if (sEdge < -0.7072) { w.tGraze = -2.0; phase = 2; gEdgePath = 7.0; }"],
    ["          w.tGraze = -2.0;\n          phase = 2;\n        } else if (!extend", "          w.tGraze = -2.0; gEdgePath = 2.0;\n          phase = 2;\n        } else if (!extend"],
    ["        w.edge = true;\n        w.cov = 1.0;\n        phase = 2;\n", "        w.edge = true; gEdgePath = 5.0;\n        w.cov = 1.0;\n        phase = 2;\n"],
    ["        } else phase = 2;\n        // 不要自阴影的调用", "        } else { phase = 2; if (shadowSteps > 0) { gNdv = dot(nFlat, -dA); gSil = silPx / 20.0; } if (shadowSteps > 0 && w.cov == 1.0) gEdgePath = grazed ? 9.0 : ((silPx >= 3.0 && dot(nFlat, -dA) >= 0.12) ? (w.edge ? 12.0 : 10.0) : 11.0); }\n        // 不要自阴影的调用"],
    ["gl_FragColor = sc;\n", "gl_FragColor = vec4(0.0);\n"],
    ["gl_FragColor = vec4(min(col, vec3(uHdrMax)), sc.a);", "gl_FragColor = vec4(wing.a, gEdgePath / 16.0, gNdv, gSil);"],
]
DUMP = r"""
const H = window.__dxHdr || {};
const out = {};
const b64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 32768) s += String.fromCharCode.apply(null, u8.subarray(i, i + 32768)); return btoa(s); };
const pack = (A, c) => { const n = A.length / 4, u = new Uint8Array(n); for (let i = 0; i < n; i++) u[i] = Math.round(Math.min(Math.max(A[4 * i + c], 0), 1) * 255); return b64(u); };
for (const k of Object.keys(H)) {
  if (!k.startsWith('cov') || k.includes('#')) continue;
  out[k] = pack(H[k], 0);
  if (k === 'covRef') out.mixed = pack(H[k], 1);
  if (k.startsWith('covPath')) { out['path_' + k] = pack(H[k], 1); out['ndv_' + k] = pack(H[k], 2); out['sil_' + k] = pack(H[k], 3); }
}
out.w = v.hdrWing.width; out.h = v.hdrWing.height;
return out;
"""
js = V["new"].get("js", "")
vs = [
    {"name": "new", "js": js},
    V["covNew"],
    V["covRef"],
    {"name": "covPath", "patch": {MATS: PATH}, "js": js},
    {"name": "dump", "js": js + DUMP},
]
json.dump([dict(job, variants=vs)], open(out, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
print(out)
