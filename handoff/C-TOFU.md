# C-TOFU：去掉积云「垂直挤出豆腐块」

分支 `worktree-agent-a2341dfa7198ef2d1`（已 merge master 到 80e0d59，含 C-FLAT）。改动只在 `src/clouds/clouds.glsl.ts`（`layerDensity` 形状段 + 新常数 / 函数）与 `src/clouds/clouds.ts`（新增 `uCuShape` uniform 与 `cumulusShape()`，`render()` 开头调用一次；没碰受光段）。

## 根因（复现 research/TOWERING.md §2.1，开关对照已由研究代理做过）

1. 形状噪声竖直方向几乎不变：`nB` 竖直周期约 18 km、`nA` 5.4 km，积云层 2–5 km → 一层之内噪声只随水平位置变 = 水平轮廓的竖直挤出。
2. 积云剖面 h 0.12–0.45 满密度平台，×4.5 饱和 → 侧壁竖直；云顶由剖面下降段统一截平，局部云顶来自 90 km 周期天气图 → 邻云等高。
3. 远处（≳150 km）形状噪声 mip 4–5（4³ 纹素），三线性小面连成竖肋。

复现机位：`v-cu-6000`（wpac 2026-09-28 09:00、6 km、积云、云量 0.35）、`vs-tow-a8`（浓积云预设、8 km）。注意 `ab` 必须加 `--cloud-live`，否则云冻结、补丁全 0 差（TOWERING 附录 C）。

## 改法

| 项 | 做法 | 位置 |
| --- | --- | --- |
| 竖直频率按层厚归一 | nA 竖直周期 = 1.3 层厚、nB = 3 层厚（晴天积云 2.9 / 6.6 km；浓积云夹在旧值 1.3 / 0.9 不再更低）。只对积云族（云型 > 0.45，smoothstep 权重），层积云 / 高积云 / 卷云照旧 | `clouds.ts` `cumulusShape()` → `uCuShape.xy` |
| 云顶随列强度变（替代平台） | σ = (d − 0.275) / max(覆盖率 − 0.275, 0.15)；云顶 = 0.25 + 0.75·σ^(1/1.2)（局部云顶单位）；`d ≤ 0.275 + 0.6·(云顶 − h)` 的斜天花板压；h > 0.8 乘法收口 | `clouds.glsl.ts` `cumulusTop()` + `layerDensity` |
| 形状噪声 mip 封顶 | `nA` ≤ 3、`nB` ≤ 2（`SHAPE_LOD_MAX`） | `layerDensity` |

试过又放弃的（坑，已写进 README 云坑点）：
- 按 0..1 从 d 里直接扣门槛：低覆盖率天气 d 最大只有覆盖率，全部云被压成扁饼（`tmp/screenshot/ctofu/z-ab1-*`）。
- 按「(覆盖率 − 0.275)·门槛(h)」扣（斜率约 0.2）：上半截整段都是刚过阈值的淡密度，被细节侵蚀啃成悬空碎块，浓积云近处满是「爆米花」（`z-m1-tow.png`）。
- 云顶下 0.12 内乘到 0（斜率约 3）：云顶光滑成塑料团子，云量掉 10%（`z-ab5-*`）。
- 固定竖直 ×2：浓积云 5 km 厚的层里叠两三个 nA 周期，塔身断成上下分离的碎块。
- 竖直倍率在着色器里按 uniform 算：cloud-march 冷编译 +10%（`layerDensity` 内联十几处），挪到 CPU。

## 指标（同页 `ab --cloud-live`，merge C-FLAT 之后的 master 为基线；输出 `tmp/screenshot/ctofu/m3/`）

口径（`handoff/C-TOFU-metrics.py`，云缓冲全分辨率 16 帧平均 α；高度出口补丁 `L = vec3(length(ro + rd*depth) - BOTTOM) * (1 - T)`，距离来自 `cloud-dist`）：
- **竖壁游程**：α 过 0.5 的侧边像素中，同一列连续 ≥ 5 行的比例；**平顶游程**：顶边像素中同一行连续 ≥ 12 列的比例；按距离带 20–100 / 100+ km。
- **云顶离散**：轮廓顶边（α>0.5、上方 <0.5）的云高度 IQR / P90−P10（km，20–150 km 带）。
- **对真值误差**：各自代码的 `cloud-ref`（1/4 步长）为真值的 |Δα| 均值（裁剪区）。

| 场景 | 竖壁 20–100 | 竖壁 100+ | 平顶 20–100 | 平顶 100+ | 云顶 IQR km | 云顶 P90−10 km | 云量（α>0.5） | 对真值 |Δα| |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| cu-6000 | 0.091 → **0.040** | 0 → 0 | 0.108 → **0.075** | 0.265 → **0.098** | 0.30 → **0.38** | 0.61 → **0.75** | 0.70 → 0.68 | 0.118 → 0.134 |
| tow-a8 | 0.082 → 0.106 | 0.015 → 0.028 | 0 → 0.001 | 0.125 → **0.011** | 0.84 → **0.91** | 1.54 → **1.85** | 0.87 → 0.86 | 0.052 → 0.063 |
| noon-cumulus | 0.107 → **0.066** | 0.041 → **0.003** | 0.034 → **0.020** | 0.324 → **0.136** | 0.30 → **0.42** | 0.60 → **0.72** | 0.74 → 0.73 | 0.092 → 0.106 |
| clouds-variety | 0.101 → **0.074** | 0 → 0 | 0.023 → 0.017 | 0.569 → **0.248** | 0.47 → 0.33 | 0.80 → 0.85 | 0.98 → 0.96 | 0.003 → 0.006 |
| cu-side | 0.048 → 0.083 | — | 0.054 → 0 | — | 0.28 → 0.33 | 0.51 → 0.71 | 0.81 → 0.85 | 0.005 → 0.003 |
| sea-sc / storm-sc | 只有 mip 封顶生效：截图平均差 0.46 / 0.27 级，对真值误差 0.0169 / 0.0095 不变 | | | | | | | |

读法：远处（100+ km）平顶 −60~−90%、竖壁基本清零；20–100 km 竖壁 −30~−55%。tow-a8 / cu-side 的 20–100 km 竖壁比例上升，是因为塔长高了、侧面轮廓变多（边像素总数 cu-side 1136 → 379，比例的分母变小），截图上没有平顶竖壁块（`cmp-tow-a8.png`、`cmp-cu-side.png`）。对真值误差的上升约一半来自 mip 封顶（不封顶时 cu-6000 0.120、noon 0.098），其余来自轮廓变多。

方向性竖肋：`ribX = E|∂x box_y7 α| / E|∂x α|` 在 100+ km 带 cu-6000 0.41 → 0.38、noon 0.46 → 0.42（竖向相干度下降）；tow-a8 0.41 → 0.46（塔的侧面变多）。这个指标区分力弱，以游程和截图为准。

### 时间行为（`flight --modes static,reset,cruise,turn`，`tmp/screenshot/ctofu/flight4/`，new / old）

| 场景（裁剪） | 静止 relStd | 对真值 err | reset@16 | cruise err | turn err | 云边模糊 σ / edge |
| --- | --- | --- | --- | --- | --- | --- |
| noon-cumulus | ×0.94 | ×0.96 | ×0.96 | ×0.97 | ×1.06 | 不变 / ×0.995 |
| clouds-variety | ×1.09 | ×1.06 | ×1.01 | ×1.11 | ×1.26 | 不变 / ×0.998 |
| cu-6000 远排 | ×1.25 | ×1.34 | ×1.34 | ×1.29 | ×1.16 | 不变 / ×0.996 |
| tow-a8 中远 | ×1.41 | ×1.23 | ×1.21 | ×1.21 | ×1.02 | 不变 / ×0.987 |
| sea-sc | ×0.98 | ×0.98 | ×1.01 | ×1.01 | ×1.00 | 不变 |
| storm-sc | ×1.00 | ×1.00 | ×1.01 | ×1.01 | ×1.00 | 不变 |

没有拖影（σ、edge 不变）；近处（noon）噪声略降。远排噪声上升：mip 封顶贡献一部分（flight3：cu-6000 远排 nocap ×1.16 / cap4 ×1.18 / cap3 ×1.21；tow-a8 ×1.27 / ×1.32 / ×1.41），其余是轮廓变多（云顶错落、塔长高）。**这是本任务最主要的代价，交审查 / 美术总监判断**；要省可以把 `SHAPE_LOD_MAX` 放到 6（等于不封顶），远处平顶会回来一部分（tow-a8 100+ km 平顶 0.011 → 0.078、竖壁 0.028 → 0.055）。

### GPU（`gpu-ab --time clouds`，8 轮 ABBA，带 A/A）

| 场景 | new / old | 其中不封顶 mip 时 |
| --- | --- | --- |
| noon-cumulus | ×1.08（0.485 → 0.520 ms） | — |
| clouds-variety | ×1.19（1.19 → 1.42 ms） | ×1.15 |
| cu-6000 | ×1.15~1.17（0.92 → 1.07 ms） | ×1.09 |
| sea-sc | ×1.03（在离散度内） | — |
| storm-sc | ×1.01（在离散度内） | — |

增量来源：mip 封顶约 3–8%（远处取细 mip，缓存不友好）；其余是云变高后视线在云里的步数（非空步不加倍、受光步进）变多。雷暴 / 层积云不受影响。

### 冷编译（`shader-budget --wait-quiet --baseline <master> --rounds 5`，min）

cloud-march 482 → 503 ms（**+4.4%**），cloud-march-storm 4004 → 4140（+3.4%）。竖直倍率在着色器里算的中间版本是 +21%（拆分：竖直倍率 −9.9%、云顶 −4.3%、mip 封顶 −2.4%，`handoff/C-TOFU-fxc-variants.mjs`）。

## 对照图（`tmp/screenshot/ctofu/`，上 old 下 new）

- `cmp-cu6000.png`、`cmp-cu6000-far-x2.png`：6 km 机位，远排从平顶长条块变成高低错落的圆顶团。
- `cmp-tow-a8.png`、`cmp-tow-a8-far-x2.png`：浓积云，中远处一块块平顶竖壁的「面包」变成一座座圆顶、云顶高低不一。
- `cmp-noon-cumulus.png`、`cmp-clouds-variety.png`：巡航俯看，云量基本不变；clouds-variety 云海顶面起伏更大，亮度均值 172 → 166（更多背光面）。
- `cmp-cu-side.png`：4.5 km 在浓积云层（1.4–6.5 km）里，强的塔现在能长到 5–5.5 km，冲出云海顶面、离相机很近——**近处的塔是软的（C06 / C13 的近处细节问题），美术总监请看是否可接受**。
- `cmp-sea-sc.png`、`cmp-storm-sc.png`：层积云 / 雷暴几乎不变。

## 复现

```
python handoff/C-TOFU-mkjobs.py tmp/ctofu-jobs.json
node scripts/dev-browser.mjs ab --port <本分支> --base <master> --angle d3d11 --cloud-live --quality high --rounds 1 --jobs tmp/ctofu-jobs.json --out tmp/screenshot/ctofu/m
python handoff/C-TOFU-metrics.py tmp/screenshot/ctofu/m old,new
node scripts/dev-browser.mjs flight --port <本分支> --base <master> --modes static,reset,cruise,turn --jobs handoff/C-TOFU-flight-jobs.json --variants handoff/C-TOFU-flight-variants.json
node scripts/dev-browser.mjs gpu-ab --port <本分支> --base <master> --rounds 8 --jobs handoff/C-TOFU-gpu-jobs.json
node scripts/shader-budget.mjs --wait-quiet --baseline <master 树>/apps/voyage --rounds 5 --only cloud-march,cloud-march-storm
python handoff/C-TOFU-stack.py <job 目录> old,new x,y,w,h <倍数> <输出.png>
```

## 给后续任务

- TW03（冲出云层的塔）：直接用 `cumulusTop()`——把局部云顶放高，只有 σ 大的芯长到顶上。`CU_DOME_BASE` / `CU_TOP_POW` 控制「多数矮、少数高」。
- 云量视觉校准（WX10）：俯看云量基本不变（noon 0.74 → 0.73、cu-6000 0.70 → 0.68），擦云层看的「平均云高」下降（cu-6000 顶边中位 1.93 → 1.81 km），强芯变高。
- `uCuShape` 每帧在 `Clouds.render()` 开头算；别的地方如果不经 `render()` 直接用云 uniform（没有），要先调 `cumulusShape()`。
