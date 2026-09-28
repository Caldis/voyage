# WX11g-b · 低风速海面太阳耀斑椒盐点（交接）

分支：`worktree-agent-a8af37645e0be0cc6`（基于 master `530c8cb`）。状态：完成，待审查。来源：`research/ART_REVIEW_wave8.md` 第 4 条；预审 `research/PERF_PREVIEW_wave8.md`「WX11g-b」。

## 根因（与预审一致，已用同页开关对照确认）

`ocean.glsl.ts` 耀斑项乘的泊松闪点 `sparkle`：λ = 5·足迹面积·exp(−tan²/σ²)，λ < 4 时每个格子要么全黑、要么亮 1/pHit 倍。命中时像素亮度 = 期望/pHit ≈ 期望/λ ∝ 1/(5πσ²·足迹面积)，与离耀斑中心多远无关——低风速（σ² 小）、近处（足迹小）时每个命中点都接近过曝，于是耀斑两侧和近处是一片孤立单像素亮点和黑点。随机数每 1/8 s 硬换一次，格子只有 1–2 像素大，飞行中必闪。粗糙度本身没问题：σ² 已经含 LEAN 过滤掉的斜率方差和 Cox–Munk 毛细波，所以美术报告里「LEAN / Toksvig 没加」的根因假设不成立（已推翻），这次改的是分布，没改 NDF。

## 改了什么（只动 `src/render/ocean.glsl.ts` 耀斑闪点段）

- 相对起伏：`sparkle = 1 + 0.5·z·√λ/(1+λ)`，z 是均值 0、方差 1 的连续随机数。λ → 0 时回到连续的期望亮度；λ ≫ 1 时 ∝ 1/√λ（与泊松同阶）；λ = 1 时最大 0.25。没有全黑像素，也没有 1/λ 倍的孤立亮点。|z| ≤ 2.45，所以 sparkle ≥ 0.39，`max(…, 0)` 夹取永远不触发，**逐像素期望严格不变**。
- 时间：每格相位不同，约 6 Hz 取一个新随机数，相邻两个随机数之间 smoothstep 过渡，并按 √(w₀²+w₁²) 归一化（过渡中途起伏幅度不缩水，同六边形平铺的方差守恒混合）。
- 随机数：原来调用两次 `oceanHash3`，现在只调用一次，给出相位和种子；两个时隙的随机数用一次向量化的 lowbias32 整数哈希（`uvec2`）算出来。没有新增函数调用点、循环或 sampler。
- 系数 0.5 的来源：在同一页面对照 k = 1 / 0.6 / 0.35（`WX11g-b-explore-jobs.json`，截图在 `tmp/screenshot/WX11g-b/explore1/`，放大拼图在 `z-ex-1.5.png`、`z-ex-14.png`）。k = 1 时，1.5 m/s 光柱边缘仍有一层单像素颗粒；k ≤ 0.6 时基本平滑。14 m/s 的碎金主要来自可分辨的 FFT 波面，四档之间几乎看不出差别。

## 验收结果

### 1. 冻结同页 ab（`tmp/screenshot/WX11g-b/ab2/`，两轮，噪声底全部为 0）

裁剪区 [400,560,800,540]。口径：耀斑区指 old 或 new 与 noglint 的亮度差 > 4 的像素；孤立亮 / 暗点指比 8 邻域的最大值还亮、或比最小值还暗 24 级以上；死白指亮度 ≥ 250 的 8 连通块；相邻差取横向和纵向的平均。

low-sea-glint（0.6 km）：

| 风速 | 孤立亮点 old→new | 孤立暗点 | 单像素死白块 | 耀斑区相邻差 | 耀斑区均亮 | 非海面像素变化 |
| ---: | --- | --- | --- | --- | --- | --- |
| 0 | 820 → **0** | 421 → 0 | 132 → 44 | 13.0 → 4.17 | 168.5 → 177.5 | 0 |
| 1.5 | 632 → **9** | 1008 → 7 | 125 → 56 | 10.6 → 4.48 | 191.1 → 194.4 | 0 |
| 3 | 777 → 117 | 1031 → 204 | 102 → 76 | 11.5 → 7.02 | 190.8 → 193.2 | 0 |
| 7 | 881 → 197 | 1087 → 202 | 111 → 97 | 13.2 → 9.69 | 182.4 → 184.0 | 0 |
| 14 | 818 → 140 | 1128 → 155 | 11 → 10 | 12.7 → 9.46 | 170.9 → 172.1 | 0 |

sea-calm-low（0.8 km，美术报告里的原场景）：1.5 m/s 孤立亮点 608 → **0**，相邻差 10.9 → 2.86；3 / 7 / 14 m/s 孤立亮点 689 / 829 / 436 → 45 / 89 / 47，耀斑区均亮 +0.4–1%。非海面像素逐位为 0。

- 非海面像素用 `seamark` 变体判定：这个变体把海面着色改成品红，凡是它和 old 逐位相同的像素，就是非海面像素。
- 耀斑区的均亮略升（+0.2–5%）。原因是旧算法的闪点被显示器夹在 255，丢掉了一部分能量；新算法不再过曝，所以亮度回来了。能量没有变差。
- 最大死白面积不变，说明光柱中心没有变化。

### 2. 飞行中逐帧（`ab` 的 `job.live`，`tmp/screenshot/WX11g-b/live1/`，240 帧，阈值 16 级，帧占比 > 5%）

| 场景 / 风速 | 闪烁像素 old → new / new2（同代码第二次） | 每帧超阈值像素 | 平均二阶差 |
| --- | --- | --- | --- |
| low-sea-glint 1.5 | 61278 → 6402 / 2541 | 13401 → 1018 / 629 | 2.04 → 0.85 |
| sea-calm-low 1.5 | 9552 → **0 / 0** | 2192 → 0.6 | 0.24 → 0.12 |
| low-sea-glint 7 | 112884 → 5027 / 6915 | 25057 → 1096 | 3.19 → 1.17 |
| low-sea-glint 14 | 130389 → 647 / 1490 | 26428 → 750 | 3.22 → 1.31 |

### 3. 性能

- `gpu-ab --time frame`，8 轮 ABBA，1.5 m/s 整帧：low-sea-glint 为 old 1.656 ms、new ×1.003 [0.984, 1.033]，A/A ×1.004；sea-calm-low 为 old 3.446 ms、new ×1.004 [0.995, 1.009]，A/A ×1.002。两者都在离散度以内，低于预审上限 +1%。计时区间里实际画的是低空细节变体（`__outCur`）。
- 离线 FXC，与 master 交替 4 轮取最小值：outside-default **−2.8%**（上限 +2%）；outside-ground-detail +2.2%（这个程序不在预审的上限表里，MAD 约 1 s，属于噪声量级）。测的时候测量锁被别的代理占着，按 SOP 只作参考。
- `check:glsl`、`typecheck`、`build`（`dist/assets` 没有 0 字节文件）都通过。`dev-browser check` 和所有 ab / gpu-ab 运行的 console error 都是 0，渲染器是 RTX 5090 / D3D11（硬件）。

## 代价 / 观感上要审查看的

- **大风时耀斑外缘不再是「黑底上的稀疏亮点」**，变成了连续的暗金色（`tmp/screenshot/WX11g-b/lsg-14-full.png` 右下）。原来那些稀疏亮点正是 14 m/s 下 13 万个闪烁像素的来源（live 表），按铁律应该去掉。碎金质感还保留着由可分辨 FFT 波面给出的那一部分（`z-ex-14.png`）。如果美术总监要找回外缘的「稀疏金点」，需要让闪点**在空间上有足迹大小的连续形状**（比如按格子做双线性的值噪声，或者把闪点画成固定屏幕尺寸的小斑），不能再用单像素两值。这会多 3 次哈希，要重新过一次预审。
- 低风速光柱在耀斑两侧的尾部由稀疏亮点变成了连续的柔光，所以看起来比原来「宽」一点。这是逐像素期望本来的样子，旧图里这部分被黑点吃掉了（`lsg-1.5-full.png`）。
- 1.5 m/s 光柱边缘还剩约 2.5–6.4 k 个闪烁像素（原来 61 k），在耀斑边缘的颗粒区。格子钉在世界坐标上，而格子只有 1–2 个像素大，飞行中像素穿过格子边界时随机数会换掉。现在起伏幅度 ≤ 0.25，看不出来；要彻底去掉，同样需要上面说的空间插值。

## 复现

```bash
# 在本 worktree 仓库根
python apps/voyage/handoff/WX11g-b-mkjobs.py            # 生成 jobs（old = 把闪点段换回 530c8cb 的原文）
cd apps/voyage && npx vite --port 5259 --strictPort       # 另开一个终端
node scripts/dev-browser.mjs ab --port 5259 --jobs apps/voyage/handoff/WX11g-b-ab-jobs.json --rounds 2 --out tmp/screenshot/WX11g-b/ab2
python apps/voyage/handoff/WX11g-b-metrics.py tmp/screenshot/WX11g-b/ab2/low-sea-glint
python apps/voyage/handoff/WX11g-b-metrics.py tmp/screenshot/WX11g-b/ab2/sea-calm-low
node scripts/dev-browser.mjs ab --port 5259 --rounds 1 --jobs apps/voyage/handoff/WX11g-b-live-jobs.json --out tmp/screenshot/WX11g-b/live1
node scripts/dev-browser.mjs gpu-ab --port 5259 --time frame --rounds 8 --jobs apps/voyage/handoff/WX11g-b-gpu-jobs.json
python apps/voyage/handoff/WX11g-b-zoom.py tmp/screenshot/WX11g-b/ab2/low-sea-glint 380,500,840,640 1 out.png old1.5 new1.5
```

- 低空（< 4 km）实际画的是 `GroundDetailVariant` 的低空细节变体，换 `outsideMat` 碰不到它（WX11g 踩过）。所以 jobs 的 `pre` 先等变体编好，再把它挂到 `__voyage.__outCur`，变体只 patch 这个材质。`gpu-ab` 同样认这个路径，程序切换核对通过（#34 / #25）。
- 对照用的 worktree `tmp/WX11g-b-base` 已删除，开发服务器已关闭。
