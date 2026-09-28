"""PERF-STORM 第七轮：跨循环存活的变量（寄存器压力）。台风变体多 4 个跨循环 float 就 ×1.36，试把只在分支里用的量挪进分支。
 flashIn：闪电通道端点 / 强度（7 个 float）挪进 uFlash.w > 0 的分支里现算（结果逐位不变）
 msKIn  ：msKRay 挪到用处现算
 phIn   ：相函数（phPeak / phBody / phMs1 / phMs2，7 个 float）挪进有云分支现算（每个有云样本多 9 次 hg）
用法（apps/voyage 下）：python handoff/PERF-STORM-mkcost7.py
"""
import json
import os
import sys

sys.stdout.reconfigure(encoding="utf-8")
HERE = os.path.dirname(os.path.abspath(__file__))
M = "clouds.marchMat"
SCENES = ["typhoon-bands", "storm-sc-low", "storm-day"]

FL_DECL = """  vec3 fA = vec3(uFlash.x - uCloudOffset.x, BOTTOM + uFlash.y, uFlash.z - uCloudOffset.y);
  vec3 fAB = vec3(uFlashB.x - uCloudOffset.x, BOTTOM + uFlashB.y, uFlashB.z - uCloudOffset.y) - fA;
  float flashI = uFlash.w / (1.0 + 0.25 * length(fAB)); // 总能量摊到整条通道上
"""
FL_USE = "      if (uFlash.w > 0.0) {\n        vec3 pw = vec3(p.x, length(p), p.z);\n"
FL_USE_NEW = ("      if (uFlash.w > 0.0) {\n"
              "        vec3 fA = vec3(uFlash.x - uCloudOffset.x, BOTTOM + uFlash.y, uFlash.z - uCloudOffset.y);\n"
              "        vec3 fAB = vec3(uFlashB.x - uCloudOffset.x, BOTTOM + uFlashB.y, uFlashB.z - uCloudOffset.y) - fA;\n"
              "        float flashI = uFlash.w / (1.0 + 0.25 * length(fAB));\n"
              "        vec3 pw = vec3(p.x, length(p), p.z);\n")
FLASH_IN = [[FL_DECL, ""], [FL_USE, FL_USE_NEW]]

MSK_DECL = "  float msKRay = mix(CLOUD_MS_STEEP, 1.0, max(smoothstep(0.3, 0.9, cosT), uCloudImmersion));\n"
MSK_IN = [[MSK_DECL, ""],
          ["      float msK = stormW > 0.5 ? 1.0 : msKRay;", "      float msK = stormW > 0.5 ? 1.0 : mix(CLOUD_MS_STEEP, 1.0, max(smoothstep(0.3, 0.9, cosT), uCloudImmersion));"]]

PH_DECL = """  vec4 phPeak = vec4(hg(cosT, 0.9), hg(cosT, 0.81), hg(cosT, 0.729), hg(cosT, 0.6561));
  float phBody = mix(hg(cosT, -0.25), hg(cosT, 0.8), 0.7);
  // 多次散射近似第 1、2 阶的相函数（g 按 c^k 变平：c = 0.5、0.25）
  float phMs1 = mix(hg(cosT, -0.125), hg(cosT, 0.4), 0.7);
  float phMs2 = mix(hg(cosT, -0.0625), hg(cosT, 0.2), 0.7);
"""
PH_USE = "      float pk = 0.75 * od;\n"
PH_IN = [[PH_DECL, ""], [PH_USE, PH_DECL.replace("  ", "      ", 1).replace("\n  ", "\n      ") + PH_USE]]

jobs = [{"name": f"c7-{s}", "scene": s, "variants": [
    {"name": "cur"}, {"name": "cur2"},
    {"name": "flashIn", "patch": {M: FLASH_IN}},
    {"name": "msKIn", "patch": {M: MSK_IN}},
    {"name": "phIn", "patch": {M: PH_IN}},
    {"name": "all3", "patch": {M: FLASH_IN + MSK_IN + PH_IN}},
]} for s in SCENES]
with open(os.path.join(HERE, "PERF-STORM-cost7-jobs.json"), "w", encoding="utf-8") as f:
    json.dump(jobs, f, ensure_ascii=False, indent=1)
print("ok")
