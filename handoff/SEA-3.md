# SEA-3 · 海面三项查因与修复（交接）

分支 `worktree-agent-a08046917b3852aff`（基于 master `5752c3c`）。端口 5262。
来源：`research/ART_REVIEW_wave8.md` 第 9 条（低空海天暗墙）、第 12 条（远海横纹、暗色尾迹）；预审 `research/PERF_PREVIEW_wave8.md` §3.2。

## 结论先行

**三项的根因都不在海面着色（`ocean.glsl.ts` / `src/ocean/*`）里**，改海面本身（风痕、阵风斑、FFT 斜率、粗糙度、水色）对三项都没有作用。根因分别落在：

| 项 | 根因位置 | 归属 | 本任务处理 |
| --- | --- | --- | --- |
| ① 低空海天暗墙 | 水面天空反射的近似 `F·(L相机(反射方向) − 内散射)`（`terrain-shading.glsl.ts` `groundFinish`、`outside-pass.ts` 开阔海面分支） | 大气透视 / 地面合成，不在归属内 | 只报告 + 给出两个已同页验证的方案（见下），**未改 src** |
| ② 远海横纹 | 空气透视 3D LUT（32×64×32）的插值分辨率，只影响真实地面路径上的海（`gh.apL / gh.apT`） | `atmosphere/*`，不在归属内 | 只报告 + 方案 |
| ③ 暗尾迹 | 航迹云合成漏了「挡在尾迹前面那段空气的内散射」 | `traffic.glsl.ts`，不在归属内 | 只报告 + 给出一行补丁（已同页验证） |

第一轮只报告；**协调者随后决定三项都在本分支落地**（见下「第二轮：落地」）。下面的诊断表是第一轮的定位过程。

## 第三轮：审查返工（①的「饱和源」夜里归零）

审查（`D:\Code\opus-test\apps\voyage\handoff\SEA-3-review.md`）P0：night-sea-milkyway 远海整片纯黑，地平线下一行 Y 65 → 0。

**根因更正**：审查把它归到开阔海面分支，但诊断（`diag-night` 组：在开阔海面分支里把 L 改写成各分量，8 个变体与 new 逐位相同）表明 **scs 夜景的海走的是真实地面路径（onGround）**，出事的是 onGround 那行：`apT·apL/(1−apT)`。开阔海面那行的 `tView·内散射/(1−tView)` 有同样的缺陷，只是这个场景没走到。共同原因：**空气透视 LUT 与天空视图 LUT 地面侧都只有太阳一路**，不含月光与气辉，夜里 ≈ 0；而原公式里的 `skyCam`（天空视图 LUT 天空侧，太阳 + 月亮两路 + 气辉）是对的。

**新的饱和源**（两个分支共用一次计算）：`skyHz` = 相机看「反射方位上的几何地平线」处的天空——天空视图 LUT 天空侧最后一行、与 `skyCam` 同一列（太阳、月亮两路）+ 气辉。几何上地平线处反射方向正好退化到这里，所以与原公式连续；这条视线同样贴着霾层走，白天就是地平线上方那条暗带的亮度（暗墙修复保留），夜里带月光与气辉，不会归零。
- onGround：`skyCam' = apL + mix(max(skyHz − apL, 0), max(skyCam − apL, 0), tUpR)`
- 开阔海面：`refl = F·mix(max(skyHz − 内散射, 0), max(skyCam − 内散射, 0), tUpR)`
- `skyHz` 直接按列坐标取 LUT 那一行（两次 `textureLod` + `nightglow`），**不调第二次 `skyRadiance`**：写成第二个 `skyRadiance` 调用点时离线 FXC outside-default +10–12%（两次实测）；放进 `+ uLoopGuard` 循环共用一个调用点则 FXC 直接编不过（分支里的循环内隐式导数取样）。

**复测**（`SEA-3-rework-jobs.json`，同页 2 轮，噪声底全 0；master = outside-pass 按 diff 反向补丁，prev8cc = 8cc6132 的公式；`SEA-3-horizon.py` 列剖面 x = 800、y 200–1000 最大相邻行跳变 + 窗内纯黑像素数）：

| 场景 | master | 8cc6132 | 返工后 |
| --- | --- | --- | --- |
| night-sea-milkyway | 纯黑 660（窗框暗角），剖面 y560–588：53 → 39 平滑 | **纯黑 30468，地平线下一行 52.7 → 0.2** | **与 master 逐行相同**（纯黑 660，剖面同上），对 master 平均差 0.29、最大 3.3、over8 = 0 |
| night-sea-fullmoon | 纯黑 717 | **纯黑 39521，70 → 0.5** | 纯黑 697；最大跳变 38.6 在月光耀斑边缘（master 48.5，同位置） |
| dusk-earthshadow | 最大跳变 2.6 | 7.4（新增的台阶） | 3.1，对 master 平均差 0.18、over8 = 0 |
| hnd-low-day（白天，暗墙） | x = 1000：143.0 → 157.7（**硬边**） | 连续 | **连续**：142.8 → 142.6 → 142.5 → …（暗墙修复保留） |
| sea-mod-low / low-sea-glint（白天低空） | — | 远海偏霾灰 | 同方向（饱和度 25.8 → 19.9%；均亮 +4 / +8 级，比 8cc 略亮、略蓝，因为饱和源是地平线天空而不是 AP 饱和内散射） |

- gpu-ab（`SEA-3-gpu-rework-jobs.json`，new 对 8cc6132，8 轮 ABBA 带 A/A）：hnd-low-day ×0.985、sea-mod-low ×0.986、night-sea-milkyway ×1.015（A/A ×1.008），全部在离散度内。
- 离线 FXC outside-default 对当前 master `83d083c`（基线树 `tmp/SEA-3-base`，期间别的代理持测量锁）：三次 +5.7% / +1.0% / +0.3%（MAD 500–900 ms），中位约 +1%，在 +2% 上限内但噪声大，**请波次收尾在安静窗口复测**；outside-ground-detail +2.1%。
- check:glsl、typecheck、build（无 0 字节文件）、`dev-browser check` console error 0。
- 对照图（左 master / 中 8cc6132 / 右返工后）：`tmp/screenshot/SEA-3/cmp-rework-milkyway.png`、`cmp-rework-fullmoon.png`、`cmp-rework-hnd.png`；`cmp-rework-seamod.png`（左 master / 右返工后）。
- ②横纹、③尾迹的代码没动。

## 第二轮：落地（协调者决定，merge master `e272ad8` 之后）

### 改了什么（3 个文件，都不碰奇观段 / 云 / LUT）

| 项 | 文件 | 改动 |
| --- | --- | --- |
| ① 暗墙（方案 B） | `render/outside-pass.ts` `outsideRadiance` | 算完 `skyCam` 后求 `tUpR = transmittanceToTop(BOTTOM, 反射视线在水面处的仰角正弦)`；真实地面路径：`skyCam = apL + mix(apT·apL/(1−apT), max(skyCam−apL, 0), tUpR)`（`groundFinish` 不用改）；开阔海面分支：`refl = F·mix(tView·内散射/(1−tView), max(skyCam−内散射, 0), tUpR)`。只动这两处，没碰 `#ifdef OUTSIDE_WONDER` 那几行（WS01 在改） |
| ② 横纹 | `render/terrain-shading.glsl.ts` `groundHit` | 空气透视 LUT 的**天顶角方向改成手动两行插值**：上下两行各取「到它自己那条视线的海平面交点的同一比例」处（`t · tBottom(行) / tBottom(视线)`），再按行权重混合；视线或某行打不到海平面时那一行退回同距离。多 2 次取样、3 次解析球面求交，**LUT 本身、LUT pass、draw 数都不变** |
| ③ 尾迹 | `render/traffic.glsl.ts` | `L += T·(Lc·apT + apL·(1 − e^−τ))`，只在 `tau > 1e-4` 分支里多取一次内散射 LUT |

**为什么横纹没按「霾顶附近加密 LUT」做**：第二轮先试了距离轴「均匀介质段」插值（透射率按距离对数线性、内散射按透射率比例，`AP_LOGZ`）——横纹 0.59 → 0.58，没用，说明主因不在距离轴。天顶角轴才是：LUT 每行在**同一距离**上取值，陡的那一行积分早已截在海面，平的那一行还在半空少穿一截霾，两行线性混合就是每行一条折线。这不是分辨率问题（行数翻倍只是把折线变密），而是参数化与「地面命中」不匹配；按「到海平面的同一比例」取就把两行都对齐到各自的地面点上。结果与逐像素积分真值的横纹指标一样（0.472 vs 0.472，周期性消失），而且不增加 LUT 的 draw 与每帧 GPU（LUT pass 0 变化）。SPEC-RAYS 读的空气透视 LUT / 云影图都**没有改**，rays 不受影响；云、交通、火车远景取 LUT 的方式也不变。

### 验收（同页 ab 2 轮，old = 本分支改动按 diff 反向补丁 = 改前着色器；噪声底 old/old#2、new/new#2 全部逐位 0；`SEA-3-accept*.json`、`SEA-3-accept.py`、`SEA-3-trail.py`）

| 项 | 场景 | old → new |
| --- | --- | --- |
| ① 暗墙硬边（x = 1000 列地平线处最大相邻行跳变） | hnd-low-day 1.5 km | **8.4（y = 526，地平线）→ 3.2**（最大跳变移到 y = 671 的海岸线，地平线处已无硬边） |
| | hnd-low-day-26 2.6 km | **8.7 → 4.7**（同上，移到海岸线） |
| ② 横纹（cruise-ground，逐行残差 RMS / 自相关主周期） | cruise-ground 10.7 km | **0.769 / 39 行 0.47 → 0.452 / 无周期（< 0.12）** |
| ③ 尾迹像素对「同代码关掉尾迹」的亮度差 | noon-cumulus 10.7 km 侧光 | **−2.70 → +0.00** |
| | noon-cu-close 3 km 侧光 | −3.54 → −1.28（剩下的是尾迹单次散射相函数本身在 3 km 侧光下偏暗，不是合成问题；真实尾迹不在 3 km） |
| | sunset 逆光对照 | +8.88 → +9.07（本来就亮，基本不变） |

**非相关像素**：用两个标记变体（`maskG` 把地面 / 海面路径涂品红、`maskT` 把尾迹涂绿）——new 与两者都逐位相同的像素即「非相关」。8 个场景里非相关像素 1.9 万–100 万个，old/new 有差的只有 5–38 个、最大 1 级，零散分布在舱壁 / 窗框上：是海面变亮 / 变暗经眩光 mip 链传过来的，不是着色器直接改的。**尾迹外**（与无尾迹同代码逐位相同的区域）new 与 old 的尾迹补丁差为 0。

**整体影响范围（取向，给美术总监看）**：方案 B 改变所有「有霾 + 远处水面」的观感——低空远海从蓝色镜面变成与地平线霾连成一片的灰霾色（sea-mod-low 裁剪区饱和度 24.5 → 20.5%、均亮 +1.2 级），巡航开阔海面整体略亮（wpac-cruise 均亮 +3.7 级、noon-cumulus 场景 +0.1）。对照图：

- `tmp/screenshot/SEA-3/cmp-hnd-low-day.png`（左改前 / 右改后，2 倍）：暗墙 + 直线消失，远海融进地平线霾
- `tmp/screenshot/SEA-3/cmp-sea-mod-low.png`（0.8 km 低空海面整窗）：远海偏霾灰，近处耀斑、细浪不变
- `tmp/screenshot/SEA-3/cmp-cruise-ground.png`（2 倍）：远海横纹消失
- `tmp/screenshot/SEA-3/cmp-trail-noon.png`（2 倍）：正午侧光的尾迹不再是暗线

### 性能与冷编译

- `gpu-ab --time frame` 8 轮 ABBA，带 old/old2 A/A，程序确有切换（`SEA-3-gpu-final-jobs.json`）：hnd-low-day ×0.998 [0.994, 1.007]（A/A ×0.996）、cruise-ground ×1.004 [0.991, 1.017]（A/A ×0.998）、sea-mod-low ×0.997 [0.981, 1.008]（A/A ×0.999）、noon-cumulus 带尾迹 ×1.015 [0.984, 1.028]（A/A ×1.008）——**全部在离散度内**，预审上限（整帧 ≤ +1%）以内；noon-cumulus 中位 +1.5% 与 A/A +0.8% 同量级，四分位跨 1。
- LUT pass：没改 LUT，GPU 时间与 draw 数都不变（LUT 程序与绘制代码零改动）。@3840×1950 的窗外 pass 按每像素多 2–3 次取样估算 < 0.02 ms（远低于 +0.2 ms 上限），未单独在该分辨率实测。
- 离线 FXC（`shader-budget --baseline tmp/SEA-3-base --rounds 4`，基线 = 合并进来的 master `e272ad8`，判定按最小值；期间别的代理持测量锁，只作参考）：**outside-default（关键路径）−2.8%**（6108 vs 6286 ms，上限 +2%）；outside-ground-detail +3.0%（12905 vs 12533，MAD 540–720 ms，噪声量级；不在关键路径）。
- `check:glsl`、`typecheck`、`build`（`dist/assets` 无 0 字节文件）通过；`dev-browser check` 与全部 ab / gpu-ab 运行 console error 0，渲染器 RTX 5090 / D3D11 硬件。

### 需要审查重点看的

1. 方案 B 的取向（远海偏灰），以及夜里 / 黄昏有霾时远海是否发灰发亮不自然（本轮只测了白天场景）。
2. `groundHit` 的两行插值在陆地山区（地形高出海面、`tB` 与 `tT` 比例 < 1）是否有新的横向断层——fuji 类场景未测。
3. 真实地面路径与开阔海面分支交界（clipmap 外缘退回海平面球）处两边的反射混合公式一致，但 `apT/apL`（3D LUT）与 `tView / 内散射`（透射率 LUT + 天空视图 LUT）来源不同，交界线是否比改前更显眼。

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

（第一轮的判断，**已被第二轮修正**：不是分辨率问题，是天顶角方向的取值与「地面命中」不匹配，见上「第二轮」）根因：真实地面路径上的海用空气透视 3D LUT（32 方位 × 64 天顶 × 32 距离，`sqrt` 映射）。霾顶是一层 ±80 m 的薄过渡层，俯看时内散射 / 透射率随距离和天顶角在穿过霾顶处变化很陡，三线性插值是分段线性的，每个 LUT 格子边界处导数跳一次——在大面积平滑的海面上就是等距的马赫带（约 39 行一条）。陆地上被纹理盖住看不出，海面平滑所以露出来。逐像素积分时横纹完全消失，同时平均亮度高约 +4 级（LUT 还有一点系统偏暗）。

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

## 方案的 GPU 代价（`gpu-ab --time frame`，8 轮 ABBA 带 A/A，`SEA-3-gpu-jobs.json`，程序确有切换）

| 场景 | 变体 | 对 cur | A/A |
| --- | --- | --- | --- |
| hnd-low-day（2.62 ms） | 方案 B `reflSurf` | ×0.994 [0.981, 0.999]，离散内 | ×0.996 |
| sea-mod-low（2.98 ms） | 方案 B `reflSurf` | ×0.958 [0.933, 0.988]（A/A 自己 ×0.965，负载噪声） | ×0.965 |
| noon-cumulus（2.41 ms，摆了尾迹） | 尾迹补丁 `fixAP` | ×1.003 [0.988, 1.015]，离散内 | ×1.000 |

两者都在预审上限（整帧 ≤ +1%）以内。离线 FXC 没测（补丁没落地；落地时按预审 outside-default ≤ +2% / ≤ +1% 复测）。

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
