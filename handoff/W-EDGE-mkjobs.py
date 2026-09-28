"""W-EDGE：生成 `dev-browser.mjs ab` 的 jobs 文件（同页 A/B + 参考图 + 覆盖率读回）。

变体：
  old     对照端口（master）的机翼着色器原文（主 + 湿窗一起换）
  new     本分支当前代码
  ref     参考图：每像素 5×5 = 25 条子射线，各自按 1/5 像素的足迹求交（命中阈值、解析覆盖率都缩到 1/5 像素）、
          给足步数（uWingSteps 256）、各自着色，按覆盖率平均；不做边缘超采样（uWingEdgeAA 0）
  cov*    把机翼覆盖率 wing.a 写进 hdrWing（r = 覆盖率，g = 参考图的「边缘像素」标记，b = 窗外遮罩 m），ab 的 hdr 读回
  dump    不渲染什么，只在 js 里把前面三张覆盖率图打包成 base64 放进 jsOut（落在 dump.json 里，给 W-EDGE-metrics.py 用）
用法：python handoff/W-EDGE-mkjobs.py <输出 jobs.json> [场景组：all | quick | biz | sun | ic | night] [额外变体 json]
"""
import json
import sys

REF_N = 5

WING_VIEW_SIG = "vec4 wingView(vec3 ro, vec3 rd, float tStart, vec3 sunC, vec3 eSky, vec3 eDown, float belowAlbedo, vec4 cloud, float refL) {"

REF_FN = """vec4 wingView(vec3 ro, vec3 rd, float tStart, vec3 sunC, vec3 eSky, vec3 eDown, float belowAlbedo, vec4 cloud, float refL) {
  vec3 rgR = uCamBasis[0];
  vec3 upR = uCamBasis[1];
  float pa0 = 2.0 * uTanHalfFov / uResolution.y;
  const int RN = %d;
  vec3 accR = vec3(0.0);
  float aR = 0.0;
  float tMin = 1e9;
  float tMax = -1e9;
  int p0 = -2;
  bool pd = false;
  int nf = 0;
  for (int i = min(uWingSteps, 0); i < RN * RN; i++) {
    vec2 o = (vec2(float(i %% RN), float(i / RN)) + 0.5) / float(RN) - 0.5;
    gPaScale = 1.0 / float(RN);
    gLastT = -1.0;
    gLastPart = -1;
    vec4 s = wingViewS(ro, normalize(rd + (rgR * o.x + upR * o.y) * pa0), tStart, sunC, eSky, eDown, belowAlbedo, cloud, refL);
    accR += s.rgb * s.a;
    aR += s.a;
    if (s.a >= 1.0) nf++;
    if (s.a > 0.0) {
      tMin = min(tMin, gLastT);
      tMax = max(tMax, gLastT);
      if (p0 == -2) p0 = gLastPart; else if (gLastPart != p0) pd = true;
    }
  }
  gPaScale = 1.0;
  gRefMixed = (aR > 0.0 && (nf < RN * RN || pd || tMax - tMin > 0.03 * tMin)) ? 1.0 : 0.0;
  return aR > 0.0 ? vec4(accR / aR, aR / float(RN * RN)) : vec4(0.0);
}

// 翼尖的航行灯（右绿左红）""" % REF_N

REF_PATCH = [
    ["float wingPixelAngle() { return 2.0 * uTanHalfFov / uResolution.y; }",
     "float gPaScale = 1.0;\nfloat wingPixelAngle() { return gPaScale * 2.0 * uTanHalfFov / uResolution.y; }"],
    [WING_VIEW_SIG, "float gLastT = -1.0;\nint gLastPart = -1;\nfloat gRefMixed = 0.0;\n" + WING_VIEW_SIG.replace("wingView(", "wingViewS(")],
    ["    if (k > 0) pool -= w.steps;", "    if (k > 0) pool -= w.steps; else { gLastT = w.t; gLastPart = w.part; }"],
    ["// 翼尖的航行灯（右绿左红）", REF_FN],
]
REF_UNI = {"sceneMat.uniforms.uWingSteps.value": 256, "sceneMat.uniforms.uWingEdgeAA.value": 0}


def cov_patch(mixed):
    return [
        ["gl_FragColor = sc;\n", "gl_FragColor = vec4(0.0);\n"],
        ["gl_FragColor = vec4(min(col, vec3(uHdrMax)), sc.a);", "gl_FragColor = vec4(wing.a, %s, m, 1.0);" % ("gRefMixed" if mixed else "0.0")],
    ]


MATS = "wingMat,wingMat.wet"
BASE = {"wingMat": "base", "wingMat.wet": "base:wingMat"}

DUMP_JS = r"""
const H = window.__dxHdr || {};
const out = {};
const b64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 32768) s += String.fromCharCode.apply(null, u8.subarray(i, i + 32768)); return btoa(s); };
for (const k of Object.keys(H).filter((k) => k.startsWith('cov') && !k.includes('#'))) {
  const A = H[k];
  if (!A) continue;
  const n = A.length / 4;
  const c = new Uint8Array(n), g = new Uint8Array(n);
  for (let i = 0; i < n; i++) { c[i] = Math.round(Math.min(Math.max(A[4 * i], 0), 1) * 255); g[i] = A[4 * i + 1] > 0.5 ? 255 : 0; }
  out[k] = b64(c);
  if (k === 'covRef') out.mixed = b64(g);
}
// 非机翼逐位照抄（按覆盖率判）：old 与 new 覆盖率都为 0 的像素上，两者的 HDR 是否逐位相同；
// 另报「只有一边覆盖率 > 0」的像素数（新长出 / 消失的覆盖）
out.nonwing = {};
for (const k of Object.keys(H)) {
  if (k === 'old' || k.startsWith('cov') || k.startsWith('ref') || k.startsWith('dump') || k.includes('#')) continue;
  const A = H.old, B = H[k], CO = H.covOld, CN = H['cov' + k[0].toUpperCase() + k.slice(1)] || (k === 'new' ? H.covNew : null);
  if (!A || !B || !CO || !CN) continue;
  let n = 0, d = 0, mx = 0, grow = 0, shrink = 0;
  for (let p = 0; p < A.length; p += 4) {
    const a0 = CO[p] > 0, a1 = CN[p] > 0;
    if (!a0 && a1) grow++;
    if (a0 && !a1) shrink++;
    if (a0 || a1) continue;
    n++;
    let dd = 0;
    for (let c = 0; c < 4; c++) dd = Math.max(dd, Math.abs(A[p + c] - B[p + c]));
    if (dd > 0) { d++; if (dd > mx) mx = dd; }
  }
  out.nonwing[k] = { px: n, diffPx: d, max: mx, grow, shrink };
}
const t = v.hdrWing;
out.w = t.width; out.h = t.height;
return out;
"""


def variants(extra, strobe):
    js = "v.wingDebug.strobe = 1;" if strobe else ""
    vs = [
        {"name": "old", "materials": BASE, "js": js},
        {"name": "new", "js": js},
    ]
    vs += [dict(e, js=(js + e.get("js", ""))) for e in extra]
    vs += [
        {"name": "ref", "patch": {MATS: REF_PATCH}, "uniforms": REF_UNI, "js": js},
        {"name": "covOld", "materials": BASE, "patch": {MATS: cov_patch(False)}, "js": js},
        {"name": "covNew", "patch": {MATS: cov_patch(False)}, "js": js},
        {"name": "covRef", "patch": {MATS: REF_PATCH + cov_patch(True)}, "uniforms": REF_UNI, "js": js},
        {"name": "dump", "js": js + DUMP_JS},
    ]
    return vs


BIZ = {"name": "biz-seated-noon", "p": {"preset": "wpac", "time": 720, "wing-pos": "8", "cabin-class": "business"}, "head": [0, 0.02, -0.42]}
NIGHT = {"name": "night-wing-on", "p": {"preset": "wpac", "date": "2026-01-16", "time": 1320, "coverage": 0.15, "cabin-light": True, "wing-pos": "8"}}
IC_OFFS = [[-10, -5], [-30, -25], [-30, -5], [-10, 15], [10, -25], [10, 15], [30, -5], [30, 35]]


def main():
    out = sys.argv[1]
    group = sys.argv[2] if len(sys.argv) > 2 else "all"
    extra = json.load(open(sys.argv[3], encoding="utf-8")) if len(sys.argv) > 3 else []
    jobs = []
    if group in ("all", "quick", "biz"):
        jobs.append({"name": "biz", "scene": BIZ, "hdr": "hdrWing", "variants": variants(extra, False)})
    if group in ("all", "quick", "sun"):
        jobs.append({"name": "sun", "scene": "sunset-wing", "hdr": "hdrWing", "variants": variants(extra, False)})
    if group in ("all", "quick", "night"):
        jobs.append({"name": "night", "scene": NIGHT, "hdr": "hdrWing", "variants": variants(extra, True)})
    if group in ("all", "quick", "ic"):
        offs = IC_OFFS if group != "quick" else IC_OFFS[:2]
        for o in offs:
            jobs.append({"name": "ic_%d_%d" % tuple(o), "scene": "in-cloud", "offset": o, "hdr": "hdrWing", "variants": variants(extra, False)})
    with open(out, "w", encoding="utf-8") as f:
        json.dump(jobs, f, ensure_ascii=False, indent=1)
    print(out, len(jobs), "jobs")


main()
