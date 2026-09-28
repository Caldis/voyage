# SPEC-BOW · 飞机上才看得到的虹（交付说明）

分支：`worktree-agent-a0cb64cb9ee3cde9a`（已合并 master 至 feceec9）。端口 5282。

## 做了什么

| 效果 | 出现条件（CPU，`render/optics.ts`） | 画法（GLSL，`render/optics.glsl.ts`，全部在 `#ifdef OUTSIDE_OPTICS`） |
| --- | --- | --- |
| **雨虹**（主虹 42° + 副虹 51°，色序相反，亚历山大暗带；主虹里面亮） | 雨区在太阳背后一侧：雷暴雨幡（`weather.storms`）或浓积云下的阵雨雨区；太阳高于 −6° | `opticsRain`：≤ 4 个高斯雨柱沿视线的**解析**光学厚度（erf 积分，雨层 [地面, 雨顶]），单次散射 `E☉·T☉·云影·(1−e^(−2τ))/2·p(θ)`；p(θ) 为 10 个代表波长的几何光学主 / 副虹（`opticsBowPhase`） |
| **阵雨雨幕**（新） | 浓积云（type ≥ 0.6–0.9、层厚 ≥ 3–4.5 km、云量 ≥ 0.15–0.3、云底 ≤ 2.5–3.5 km）；80 km 世界格子、每格每 50 分钟一段、约三成的段有雨，sin² 生消 | 同上雨柱：`L·Tv + (1−Tv)·airL` + 太阳 / 天空漫散射；按最接近轴线的水平位置叠竖直雨丝噪声 |
| **云虹 / 雾虹**（与宝光同框，宝光在对日点、云虹在外圈约 38°） | 与宝光同一片水滴云、同一段云滴半径；宝光这一段开着时约六成同时有 | `opticsCloudBow`：乘在云辐亮度上 `1 + k·(p_Mie(θ) − p_ref)`，k = π / (R·(μ0+μ))（单次散射份额），Mie 拟合表按云滴半径插值 |
| **环地平弧**（可选） | 卷云 + 这一段有片状冰晶（幻日那一段）+ 太阳 ≥ 58° | `opticsArcRadiance`：仰角 e = acos√(cos²h + n² − 1)，与方位无关，红在上 |
| **日柱**（可选） | 同上冰晶 + 太阳 −1°–6° | 同函数：太阳上下的竖直光柱，长度 2.5 × 冰晶倾斜 |

演示入口：`?bow=1`（= `?optics=bow`）或 `__voyage.optics.force = { bow: true }`：强制云虹 + 宝光、在对日点外 46° 那一圈（主 / 副虹之间）上、窗外往下约 20° 的方向摆一片演示阵雨（高斯半径 18 km、中心消光 0.9 /km），卷云里强制片状冰晶。`resetBowDemo()` 重摆；时间被拨动、雨区离开虹圈 15° 以上会自动重摆。

回归场景（表尾，两处同步）：`bow-rain`、`bow-cloud`（贴窗）、`bow-cha`。

## 物理依据与出处（标「估算」的不是测量值）

- **水的折射率**：Daimon & Masumura 2007（Applied Optics 46(18):3811）20 °C 四项 Sellmeier 式；核对 0.589 µm → 1.33336（Hale & Querry 1973 为 1.333）。
- **雨滴相函数**：几何光学，入射参数均匀取样 40 万条，k = 0 外反射 / 1 次内反射（主虹）/ 2 次内反射（副虹），Fresnel 按 s、p 偏振分别算再平均；∫p dΩ = 1（含衍射峰，几何部分占一半）。与太阳圆盘（0.2667°）和 Airy 展宽 + 雨滴谱（高斯 σ = 0.25°，**估算**）卷积。
  - Descartes 角（相对对日点）：主虹 40.76°（415 nm）– 42.39°（685 nm），副虹 53.28° – 50.32°（色序相反）。文献常引 40.6–42.4° / 50.4–53.5° ✓。
  - 亮度层级（绿通道，等能白光，/sr）：主虹峰 0.063，主虹里面 30° 处 0.0107，暗带 45.5° 0.0008，副虹峰 0.0101，副虹外 58° 0.0023。主虹峰 / 暗带 76、副虹峰 / 暗带 12、主虹里面 / 暗带 13。
  - 着色器模型：焦散 Re[(x − i·w)^(−1/2)]（w = 0.26°，拟合）+ 亮侧二次填充，各波长共用形状、只有 Descartes 角随波长变；5°–70° 对数值解 RGB 平均相对误差约 6%、最大误差 / 峰值 ≤ 7%（`python handoff/SPEC-BOW-optics.py` 复现）。
- **色匹配**：CIE 1931 2° 色匹配函数的多瓣高斯近似（Wyman, Sloan & Shirley 2013，JCGT 2(2)），XYZ → 线性 sRGB（IEC 61966-2-1），400–700 nm 分 10 段按段积分、等能白归一；负值（色域外光谱色）合成后截到 0。
- **云虹**：BHMIE（Bohren & Huffman 1983 附录 A）自写 numpy 版，伽马分布有效方差 0.1，有效半径 5 / 7 / 10 / 14 / 20 µm。拟合结果：中心 37.4° → 39.6°（绿），宽（高斯 s）5.0° → 2.5°，外缘微红、内缘微蓝（红中心比蓝靠外 0.4–0.8°），几乎白。文献：雾虹比雨虹小（约 36–40°）、宽、近白 ✓。
  - 强度：厚云顶单次散射份额 L_ss/L = π·p/(R·(μ0+μ))，R = 0.75（**估算**），k 封顶 8；这样算出 HDR 亮带约 +10%，色调映射后只剩 3–4%，按照片（与宝光同框的云虹显示对比约一成）定标 ×2（`CLOUDBOW_GAIN`，**估算**）；距离冲淡取宝光那条的平方根（**估算**）。
- **环地平弧**：矢量折射推导（侧面保持竖直分量、底面保持水平分量）→ e = acos√(cos²h + n² − 1)；冰折射率沿用 T17（Warren 1984 实部）；n = 1.311 时太阳 ≥ 58° 才有（文献 57.8° ✓）。份额 1e-2、方位宽 0.6 rad（**估算**）。
- **日柱**：份额 4e-4、长度 2.5 × 倾斜（**估算**）。
- **阵雨**：消光 0.3–1.2 /km（中到大阵雨能见度 1–10 km，Koschmieder σ = 3.9/V，**估算**）；雷暴雨幡按 `clouds.glsl.ts` 的 `rainDensity` 折算（中心偏下风 0.25R、高斯半径 0.45R、中心消光 1.7 /km × 云密度倍率）。阵雨出现频率（三成）是**估算**（西太暖池浓积云占降水性对流云一半以上，research/TOWERING.md）。

## 截图（`tmp/screenshot/SPEC-BOW/final/`，同机位冻结 a = 关 / b = 开）

- `bow-rain.a/b.png`（wpac 2026-06-21 09:20，太阳 57.6°，右座，浓积云 0.3）：主虹横穿窗下半部，**红在外（上）、黄绿、蓝紫在内**；被前面的积云挡断；虹内比虹外亮。`crop-rain.png`（放大）、`crop-rain-ct3.png`（对比 ×3，可见虹内亮、外侧暗带与很淡的副虹）、`ratio-rain.png`（开 / 关亮度比，p99 1.12）。
- `bow-cloud.a/b.png`（贴窗 06:00，太阳 15°，层积云 0.85）：宝光在左下，云虹是右侧一道宽而淡的竖直白带（大圆在直线透视里近似直）；`ratio-cloud.png`：宝光彩环 + 云虹带（显示对比约 +7.7%）。
- `bow-cha.a/b.png`（13:44，太阳 62°，卷云 0.9）：窗上沿一道与地平线平行的彩带，红在上；`crop-cha.png`。
- 与真实照片描述对照：色序（主虹红外、副虹红内）✓、角半径（42° / 51°，云虹约 38°）✓、亮度层级（主虹 > 虹内 > 副虹 > 暗带；云虹淡白、宝光更艳）✓、环地平弧平行地平线且红在上 ✓。

## 数字

- **默认窗外程序**：`node scripts/shader-parity.mjs --base master` → `outside-default` 预处理后与 master 逐字相同；只有 `outside-extras / -ground-detail / -rail`（带 OUTSIDE_OPTICS 的变体）不同。`check:glsl` 的 PERF-13 断言加了 `opticsRain / opticsBowPhase / opticsCloudBow / opticsArcRadiance / uBowRain / uBowOn / uOpticsArc`，全部通过。
- **冷启动**：`dev-browser.mjs cold` 批次仍是「窗外（默认）/ 舱内 / 机翼 / 座椅 / 云 #0–2」，窗外材质程序数 1；OW 仍在首帧后 90 帧后台预编，不在冷启动批次。
- **OW 离线 FXC**（`shader-budget.mjs --baseline <master> --rounds 3`，与别的代理并行、有负载）：`outside-default` −1%（噪声），`outside-extras` 13.3 → 15.1 s，**+13.5%**（初版 +23%，把雨的受光从 `cloudShadow` 改成单次取样后降下来；消融见 `handoff/SPEC-BOW-fxc-variants.mjs`：雨区约 −10%、云虹 −2.5%、弧 / 日柱 0）。OW 不在关键路径上。
- **GPU 在场增量**（`gpu-ab --time frame --rounds 8`，`handoff/SPEC-BOW-gpu-jobs.json`）：bow-rain 整帧 3.41 ms，开 / 只宝光 / 全关三者差异都在离散度内（< 3%）；bow-cloud 3.16 ms，全关（退回默认程序）×0.94（含宝光 + 本机影子整个 OW 的开销）。
- **飞行中不闪**（`ab` 的 `live`，360 帧、飞机照常飞，阈值 16 级，`handoff/SPEC-BOW-ab-jobs.json`）：bow-rain 虹区闪烁像素 8 / 6（cur / cur2 噪声底），关掉光学 11（积云本身）；bow-cloud 宝光区 0 / 0（关 2）、云虹区 0 / 1（关 0）。
- typecheck、build、`dist/assets` 无 0 字节、`check:glsl` 全过；各轮 shots 控制台 0 error。

## 需要协调者接入 / 越出归属的改动

- `src/main.ts` 一处（`optics.update` 多传 5 个字段：`sunDir, storms, upperWind, cloudOffset, outward`），已在分支上改好。
- `scripts/lint-shaders.mjs`：EXTRA_IDS 加 7 个标识符（PERF-13 断言）。
- `scripts/scenarios.mjs`、`scripts/regression.playwright.js`：表尾三条场景（放表尾是因为开了 `optics.force.bow`，别串到后面的场景）。
- 没动 clouds 步进、wonders、wing、ocean、weather.ts。

## 已知问题 / 可以继续做的

- 舷窗视场（竖直 50°）装不下 84° 的整圈虹，只看得到弧；「全圆」只在物理上成立（从巡航高度整圈都落在地平线以下的雨上），要真看整圈得等「转头 / 广角」一类的交互。
- 阵雨雨区不知道积云单体在哪（窗外程序 sampler 已满，不能再读天气图），雨柱与头顶的云只在大尺度上对得上；近处偶尔会看到雨落在云隙下。
- 雷暴雨幡的雨虹从巡航高度基本被塔身挡住（物理如此），雨虹主要靠阵雨雨区。
- 槽只有 4 个：雨柱多于 4 个时按「强度 / 距离」取前 4，雷暴排在阵雨后面；极少数情况下换槽会让一个远处雨柱跳变（未见到，未专门测）。
- 日柱在现有卷云预设里很难看出（卷云只在太阳那一小段、又被太阳眩光盖住），`bow-pillar` 没进回归场景；环地平弧只在卷云够厚的方位上显色。
- 云虹定标 ×2 与环地平弧 / 日柱份额是估算，美术总监可再按照片调。
- 台风雨带没有接入雨区（云步进里的台风雨是另一套密度，没有解析形状）。

## 怎么复现

```
cd apps/voyage && npx vite --port 5282 --strictPort
node scripts/dev-browser.mjs shots --port 5282 --scenes-file apps/voyage/handoff/SPEC-BOW-scenes.json --out tmp/screenshot/SPEC-BOW/final \
  --pair "v.optics.disabled=true" --pair "v.optics.disabled=false"
python handoff/SPEC-BOW-ratio.py <开.png> <关.png> <输出.png> 0.15      # 开 / 关亮度比
node handoff/SPEC-BOW-mkscenes.mjs <输出.json> [场景名,…]                 # 扫一天找「窗中心离对日点 N°」的时刻（新场景用）
python handoff/SPEC-BOW-optics.py [--emit]                                 # 光学参数与拟合误差
node scripts/dev-browser.mjs gpu-ab --port 5282 --jobs apps/voyage/handoff/SPEC-BOW-gpu-jobs.json --time frame --rounds 8
node scripts/dev-browser.mjs ab --port 5282 --jobs apps/voyage/handoff/SPEC-BOW-ab-jobs.json
node scripts/shader-budget.mjs --variants handoff/SPEC-BOW-fxc-variants.mjs --only outside-extras --rounds 3
```
