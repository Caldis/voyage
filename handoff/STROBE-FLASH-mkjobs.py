# STROBE-FLASH：生成候选修法的 jobs（着色器文本补丁），免得在 JSON 里手写转义
# 用法：python handoff/STROBE-FLASH-mkjobs.py <输出.json> <场景名,…> <模式：shot|live>
import json
import sys

OLD_I = "if (i == 1) return vec3(1.0, 0.98, 1.0) * 1500.0 * uStrobe;"
# 频闪朝眼睛的发光强度按 W-LAMP 的配光（wingLampSurfI 的 i == 1 分支）
NEW_I = (
    "if (i == 1) { float hh = length(dir.xz); float s2 = dir.y * dir.y;"
    " float fv = 0.2 + 0.8 * (0.7 * exp(-s2 / 0.0149) + 0.3 * exp(-s2 / 0.147));"
    " float fh = mix(0.15, 1.0, smoothstep(-0.25, 0.25, dir.z / max(hh, 1e-6)));"
    " return vec3(1.0, 0.98, 1.0) * 1500.0 * uStrobe * fv * mix(0.575, fh, smoothstep(0.05, 0.3, hh)); }"
)
OLD_CORE = "L += I / (M_PI * 0.03 * 0.03) * 1e-3 * core * exp(-sigma * t); // cd/m² → kcd/m²"
OLD_FOG = "vec3 Iavg = i == 1 ? I : wingLampIntensity(i, vec3(1.0, 0.0, 0.3)) * 0.3;"
NEW_FOG = "vec3 Iavg = i == 1 ? vec3(1.0, 0.98, 1.0) * 1500.0 * 0.2 * uStrobe : wingLampIntensity(i, vec3(1.0, 0.0, 0.3)) * 0.3;"


def core_cap(c):
    return f"L += (i == 1 ? I / (1.0 + I.g / {c:.1f}) : I) / (M_PI * 0.03 * 0.03) * 1e-3 * core * exp(-sigma * t); // cd/m² → kcd/m²"


NOFLASH = "Object.defineProperty(v.exposure, 'flash', { get() { return 0; }, set() {}, configurable: true });"
UNFLASH = "delete v.exposure.flash; v.exposure.flash = 0;"


OLD_ERODE = """    float m = 1e30;
    for (int i = -1; i <= 1; i++)
      for (int j = -1; j <= 1; j++) m = min(m, texelFetch(uPrevLocal, clamp(p + ivec2(i, j), ivec2(0), sz), 0).g);"""
# 开运算（3×3 腐蚀再 3×3 膨胀）：孤立 / 小于 3×3 的运动差照样归零，成片的闪光（频闪光晕的径向坡）恢复原值，不再被削一圈
NEW_OPEN = """    float m = 0.0;
    for (int qi = -1; qi <= 1; qi++)
      for (int qj = -1; qj <= 1; qj++) {
        float mq = 1e30;
        for (int i = -1; i <= 1; i++)
          for (int j = -1; j <= 1; j++) mq = min(mq, texelFetch(uPrevLocal, clamp(p + ivec2(qi + i, qj + j), ivec2(0), sz), 0).g);
        m = max(m, mq);
      }"""


def variant(name, cap=None, fog=True, direct=True, mode="shot", noflash=False, opening=False):
    pairs = []
    if direct:
        pairs.append([OLD_I, NEW_I])
    if cap is not None:
        pairs.append([OLD_CORE, core_cap(cap)])
    if fog:
        pairs.append([OLD_FOG, NEW_FOG])
    js = f"patch(v.wingMat, {json.dumps(pairs)});" if pairs else ""
    if opening:
        js += f" patch(v.exposure.localMat, {json.dumps([[OLD_ERODE, NEW_OPEN]])});"
    if noflash:
        # 频闪不进 T48c 的闪光事件（exposure.flash 恒 0；闪电已被工具按住，不受影响）；keep 复原时把属性删掉再写回
        js += " " + NOFLASH + " keep({ set flash(x) { " + UNFLASH + " } }, 'flash');"
    v = {"name": name, "js": js}
    if mode == "shot":
        v["shot"] = True
    return v


out, scenes, mode = sys.argv[1], sys.argv[2].split(","), sys.argv[3]
cands = [
    {"name": "cur"},
    variant("curOpen", direct=False, fog=False, mode=mode, opening=True),
    variant("dir", mode=mode),
    variant("dirOpen", mode=mode, opening=True),
    variant("dirC60", cap=60, mode=mode),
    variant("dirC60Open", cap=60, mode=mode, opening=True),
    variant("dirC20Open", cap=20, mode=mode, opening=True),
]
if mode == "shot":
    cands[0]["shot"] = True
else:
    cands.append({"name": "cur2"})
jobs = [{"name": s, "scene": s, "variants": cands} for s in scenes]
with open(out, "w", encoding="utf-8") as f:
    json.dump(jobs, f, ensure_ascii=False, indent=1)
print("写出", out, len(jobs), "个 job")
