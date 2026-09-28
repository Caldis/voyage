# SEA-3 · 海面三项查因（交接）

分支 `worktree-agent-a08046917b3852aff`（基于 master `5752c3c`）。端口 5262。
来源：`research/ART_REVIEW_wave8.md` 第 9 条（低空海天暗墙）、第 12 条（远海横纹、暗色尾迹）；预审 `research/PERF_PREVIEW_wave8.md` §3.2。

## 结论先行

**三项的根因都不在海面着色（`ocean.glsl.ts` / `src/ocean/*`）里**，改海面本身（风痕、阵风斑、FFT 斜率、粗糙度、水色）对三项都没有作用。根因分别落在：

| 项 | 根因位置 | 归属 | 本任务处理 |
| --- | --- | --- | --- |
| ① 低空海天暗墙 | 水面天空反射的近似 `F·(L相机(反射方向) − 内散射)`（`terrain-shading.glsl.ts` `groundFinish`、`outside-pass.ts` 开阔海面分支） | 大气透视 / 地面合成，不在归属内 | 只报告 + 给出两个已同页验证的方案（见下），**未改 src** |
| ② 远海横纹 | 空气透视 3D LUT（32×64×32）的插值分辨率，只影响真实地面路径上的海（`gh.apL / gh.apT`） | `atmosphere/*`，不在归属内 | 只报告 + 方案 |
| ③ 暗尾迹 | 航迹云合成漏了「挡在尾迹前面那段空气的内散射」 | `traffic.glsl.ts`，不在归属内 | 只报告 + 给出一行补丁（已同页验证） |

按简报「大气透视若是根因，先报告再动」，本分支**没有改任何 src 文件**，只提交诊断脚本、任务文件与本文。三个补丁都已写成 ab 变体（`SEA-3-mkjobs.py`），协调者拍板后可直接落地。

## 诊断表（全部为同页 ab，冻结，RTX 5090 / d3d11 硬件，1600×1200，console error 0）

低空场景画的是低空细节变体，jobs 的 `pre` 把它挂到 `__voyage.__outCur`（WX11g-b 绕法）。逐像素「真值」积分要把 `atmosphere.hazeUniforms` 的 `uHaze / uHazeShape` 挂进窗外材质（`PRE_HAZE`），否则窗外程序里这两个 uniform 是默认 0 = 无霾，得到的是**错误的真值**——我第一轮就被它骗了（见「踩坑」）。

### ① 低空海天暗墙（hnd-low-day：hnd-cts 1.5 km / 2.6 km、09:00，窗外朝东太平洋）

列剖面（x = 1000，亮度 Y，截图 0–255）：天空 157 → 地平线上方 20 px 一条暗带降到 138 → **一行之内跳到 153 的海面** → 往近处缓降。

| 变体（`diag-wall*` / `diag-truth`） | 结果 | 说明 |
| --- | --- | --- |
| `tintGround`（真实地面路径染红） | 硬边以下全红，暗带不红 | 海面整段走真实地面路径，暗带是天空 |
| `tintSea` / `uDebug 5–7`（开阔海面分支） | 与 cur 逐位相同 | 这个场景不走开阔海面分支 |
| `exactSky`（天空改逐像素 64 步积分，**带霾**） | 与 cur 平均差 0.07 | 暗带是天空视图 LUT 正确算出来的（视线擦过霾层），不是 LUT 误差 |
| `exactAll`（天空 + 空气透视 + 反射天空全部逐像素积分） | 硬边仍在（138 → 152.7） | 不是 LUT 精度问题 |
| 分量：`apL` / `skyCam` / 反射项 / 离水 | 硬边处 apL = 137（≈ 暗带），skyCam = 157，反射项 ≈ +15，离水 ≈ 0 | **海面比地平线天空亮出来的那一截全是天空反射项** |

根因：反射项按 `F·(L相机(反射方向) − 内散射(相机→水面))` 近似「水面看到的天空 × 透射率」。这个近似假设从水面往反射方向看的天空 ≈ 从相机往同一方向看的天空。相机在 1.5–2.6 km、**霾顶之上**（这时霾顶 1.1–1.8 km、过渡层 ±80 m），水面却**埋在霾里**：掠射时水面实际反射的是一整段霾（和地平线上方的暗带同一种东西），而相机往反射方向（约 −0.3 ~ −0.6°）看到的是霾顶之上的亮天空。于是地平线以下一两个像素内海面就比暗带亮 15 级，形成「暗带 + 下沿直线 + 亮海」的墙。几何上的地平线是连续的（反射方向在地平线处恰好退化到 −dip），错在亮度随掠射角上升得太快。

方案（都已同页验证，都是改 `outside-pass.ts` / `terrain-shading.glsl.ts`，**不在本任务归属**）：

| 方案 | 做法 | hnd-low-day | 副作用（对 cur 平均差 / 最大） |
| --- | --- | --- | --- |
| A `reflClamp` | 反射项上限 `apT·skyCam`（开阔海面 `tView·skyCam`） | 硬边消失（138.1 → 137.2 连续） | cruise-ground / wpac-cruise / noon-cumulus 0；sea-mod-low 0.12 / 4.7；**低空远海整片变成均匀灰、海岸线对比几乎没了**（`tmp/screenshot/SEA-3/z-wall-clamp.png`） |
| B `reflSurf`（推荐） | 按水面处往反射方向到大气顶的透射率 `tUp = transmittanceToTop(BOTTOM, sinε)` 混合：tUp → 1 沿用原公式，tUp → 0 改成反射「视线这段霾的饱和内散射」`apT·apL/(1−apT)` | 硬边消失，远海并入地平线霾 | hnd 0.43 / 17；sea-mod-low 0.97 / 24（地平线附近的海也融进霾里，饱和度 27 → 21，`z-seamod-surf.png`）；cruise-ground 0.87 / 7；wpac-cruise 1.6 / 11；noon-cumulus 0.74 / 11；sunset 0.68 / 16 |

B 是物理上说得通的那一个（水面在霾里就该反射霾），多一次透射率 LUT 取样（窗外程序已有这个 sampler，不新增）+ 几条 ALU，**不新增 sampler / 循环 / 重函数调用点**；但它改变了所有有霾时的远海观感（「宁可有雾」方向），属于要美术总监看一眼的取向：低空远海不再是蓝色镜面而是灰霾色。A 更保守但把远海也压平了，不推荐。

### ② 远海横纹（cruise-ground：hnd-cts 10.7 km 俯看海岸外的海）

指标 `SEA-3-stripes.py`：裁剪区逐行平均亮度去掉 31 行滑动平均后的残差 RMS + 自相关主周期；列方向同样算一遍当对照。cur：行残差 0.75–0.85、列 0.04–0.11，**主周期 39 行、自相关 0.44–0.50**（美术报告原图同样 39 行 / 0.46）。

| 变体 | 行残差 RMS | 周期 / 自相关 | 结论 |
| --- | --- | --- | --- |
| cur | 0.75–0.85 | 39 / 0.44–0.50 | |
| 去风痕 / 去阵风斑 / 水色改默认 / 粗糙度只用 Cox–Munk / uDebug 8·11·12 | 0.72–0.77（uDebug 8 为 0.50） | 38 / 0.46 | **海面着色不是来源** |
| `exactSkyCam`（反射天空逐像素积分） | 不变 | — | 不是天空视图 LUT |
| `lutAP48` / `lutAP64`（空气透视 LUT 积分步数 24 → 48 / 64） | 0.74 | 39 / 0.44 | 不是 LUT 的积分步数 |
| `exactAP24` / `exactAP64`（空气透视逐像素积分，24 / 64 步，带霾） | 0.43–0.46 | **无周期**（自相关 < 0.16） | **根因在空气透视 LUT 的 3D 插值** |
| `bsplineZ`（LUT 距离层改三次 B 样条重建） | 0.56 | 39 / 0.35 | 距离层插值是一部分 |
| `bsplineY`（天顶角行改 B 样条） | 0.58 | 39 / 0.22 | 天顶角行也是一部分 |
| wpac-cruise（开阔海面，不走 AP LUT） | 行 / 列比 1.6（cruise-ground 为 7–22） | 无明显周期 | 开阔海面没有这个问题 |

根因：真实地面路径上的海用空气透视 3D LUT（32 方位 × 64 天顶 × 32 距离，`sqrt` 映射）。霾顶是一层 ±80 m 的薄过渡层，俯看时内散射 / 透射率随距离和天顶角在穿过霾顶处变化很陡，三线性插值是分段线性的，每个 LUT 格子边界处导数跳一次——在大面积平滑的海面上就是等距的马赫带（约 39 行一条）。陆地上被纹理盖住看不出，海面平滑所以露出来。逐像素积分时横纹完全消失，同时平均亮度高约 +4 级（LUT 还有一点系统偏暗）。

方案（`atmosphere/*`，不在本任务归属）：
1. 首选：空气透视 LUT 的天顶角轴与距离轴各加密一倍（64×128×64 或只把 z 加到 64），每帧 LUT 绘制 32 → 64 次 draw（PERF-CPU 记过这里是 draw 大头），需要性能工程师先估；
2. 便宜版：地面取 AP LUT 时沿 z、y 做 B 样条重建（本诊断的 `bsplineZ/Y` 写法，每轴多 2 次取样 × 2 张纹理），单轴只能消掉约三分之一到一半，两轴都做要 8 次取样，关键路径程序不划算；
3. 根治：LUT 的距离轴按「穿过霾顶的距离」自适应（在霾顶附近加密），或霾顶附近改用解析的一段积分。

### ③ 暗尾迹（noon-cu-close 与 noon-cumulus 正午侧光、sunset 对照）

用 pre 把 0 号飞机摆到窗外正前方（`traffic_pre`），尾迹横穿窗口。尾迹像素（与 `noTraffic` 差 > 2）上对背景的平均亮度差：

| 场景 | cur | `fixAP` |
| --- | --- | --- |
| noon-cu-close（3 km，40 km 外 +0.3 km） | **−3.99**（比天空暗） | −1.38 |
| noon-cumulus（10.7 km，60 km 外 +0.6 km） | **−3.19** | −0.01 |
| sunset（10.7 km，50 km 外 +0.3 km） | +9.78（比天空亮） | +9.95 |

根因：`outside-pass.ts` 合成是 `view·T尾迹 + tr.rgb`，`trafficRadiance` 里 `tr.rgb` 只含 `apT·Lc`。背景 `view` 已经含了相机到无穷远的整段内散射，乘 `T尾迹` 时把「相机到尾迹这一段」的内散射也一起挡掉了，但没有补回来。几十公里的前景内散射占侧光天空亮度的相当一部分，所以正午侧光的尾迹是暗线；逆光（前向散射峰）时尾迹本身够亮，看不出来。美术总监的「这一条是假设」得到证实（不是太阳方位，是合成公式）。

补丁（`traffic.glsl.ts`，一行，多一次空气透视内散射 LUT 取样，sampler 已存在）：

```glsl
      L += T * (Lc * apT + texture(uAerialInscatterS, uvw).rgb * uSunIlluminance * (1.0 - exp(-tau)));
```

即 `view' = view·e^−τ + apL·(1 − e^−τ) + apT·Lc`。只在尾迹像素上多一次取样（`tau > 1e-4` 分支内），整帧 GPU 应在噪声内；尚未测 FXC（预审上限 outside-default ≤ +1%）。

### 附：大风海面巡航读成云（ART-8 #8 余项）

与上面三项不同源（开阔海面不走 AP LUT，横纹 / 墙的机制都不涉及白浪），只记录，不在本任务里查。

## 验收项现状

- 本分支 src 零改动，所以「非海面像素逐位 0」「gpu-ab」「冷编译」都是平凡满足；三项的「前后对比明显改善」只在 ab 变体里成立（见上表与截图），要等协调者决定是否把补丁落到对应文件。
- `check:glsl` / typecheck / build：未改 src，交付前照跑一次（见下）。

## 截图与复现

- 截图：本 worktree `tmp/screenshot/SEA-3/`（`base/`、`diag-*`、`proto/`、`proto2/`；放大图 `z-wall-tint.png`、`z-wall-clamp.png`、`z-wall-surf.png`、`z-seamod-surf.png`）。
- 复现（仓库根）：`python apps/voyage/handoff/SEA-3-mkjobs.py <组>` 生成 `SEA-3-<组>-jobs.json`，`cd apps/voyage && node scripts/dev-browser.mjs ab --port <端口> --jobs apps/voyage/handoff/SEA-3-<组>-jobs.json --rounds 1 --out tmp/screenshot/SEA-3/<组>`；横纹指标 `python apps/voyage/handoff/SEA-3-stripes.py 700,60,550,260 <图...>`。
  组：`diag-wall`、`diag-wall2`、`diag-truth`（暗墙定位）、`diag-stripes`、`diag-stripes2`、`diag-stripes3`（横纹定位）、`diag-contrail`（尾迹）、`proto`、`proto2`（方案 A / B 与 AP LUT 步数）。

## 踩坑

- **窗外程序里调用 `integrateSegment` 当真值时没有霾**：`uHaze / uHazeShape` 只挂在 LUT 材质的 uniforms 上，窗外程序虽然声明了（`ATMOSPHERE_COMMON`），值是默认 0。第一轮「逐像素真值」因此没有霾，得出「暗带是天空视图 LUT 误差」的错误结论（已推翻）。修法：诊断变体的 pre 把 `v.atmosphere.hazeUniforms` 的两个对象挂进 `__outCur.uniforms`。识别：逐像素积分的变体整体亮度 / 饱和度与 cur 差很多（cruise-ground 均亮差 10 级），先怀疑参数没接上。
- 尾迹诊断第一次把飞机摆在侧后方、尾迹整个在视野外，三个变体逐位相同，看起来像「补丁无效」。摆放要让尾迹穿过窗口中央（`traffic_pre` 的 back 取正）。
