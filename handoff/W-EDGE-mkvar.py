"""W-EDGE：生成 W-EDGE-mkjobs.py 的「额外变体」文件（每个变体配一个 cov<名> 覆盖率读回变体，给 W-EDGE-metrics.py 用）。
补丁都相对当前工作区的 wing.glsl.ts。用法：python handoff/W-EDGE-mkvar.py <输出.json> <组>
"""
import json
import sys

MATS = "wingMat,wingMat.wet"
COV = [
    ["gl_FragColor = sc;\n", "gl_FragColor = vec4(0.0);\n"],
    ["gl_FragColor = vec4(min(col, vec3(uHdrMax)), sc.a);", "gl_FragColor = vec4(wing.a, 0.0, m, 1.0);"],
]
FB = "          if (t <= tExit) { w.edge = true; w.cov = 1.0; }\n"
NOFB = [FB, ""]
FBD = [FB, FB.replace("t <= tExit", "t <= tExit && d < 2.0 * fp")]
L64 = [["limit = i + 33;", "limit = i + 64;"], ["(shadowSteps > 0 ? 48 : 0)", "(shadowSteps > 0 ? 80 : 0)"]]

GROUPS = {
    "cont": {
        "nf": [NOFB],
        "nfl64": [NOFB] + L64,
        "fbd": [FBD],
        "fl64": L64,
    },
}


def main():
    out, g = sys.argv[1], sys.argv[2]
    vs = []
    for name, patch in GROUPS[g].items():
        vs.append({"name": name, "patch": {MATS: patch}})
        vs.append({"name": "cov" + name[0].upper() + name[1:], "patch": {MATS: patch + COV}})
    json.dump(vs, open(out, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print(out, len(vs))


main()
