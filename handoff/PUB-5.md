# PUB-5 · 襟翼滑轨整流罩下沿 / 尾端 1 px 硬台阶

- 来源：美术总监发布审查 `handoff/PUB-3b-art.md` B2（首屏视觉中心附近，锯齿 / 闪烁是最高优先级缺陷）。
- 分支 `worktree-agent-a6596b32bd9248753`，开发端口 5305，对照 5380（`D:\Code\opus-test\tmp\pub5-base`，master f7669ac，已删）。
- 归属：`src/render/wing.glsl.ts`（`wingCanoe`、`wingTrace` 探测段）；README「舱内与倒影」坑点一条；工具 `handoff/PUB-5-*`。
- 测量环境：RTX 5090 / ANGLE d3d11 硬件渲染（每次运行核对 GL_RENDERER），测前 `nvidia-smi` GPU 0–1%，测量持锁，URL 带 voyage=0；全程 console error 0。

## 根因

1. `wingCanoe` 的椭圆截面距离写成 `(|p/r| − 1)·min(wz, hy)`：按短轴缩放，长轴方向（整流罩的上下沿）只有真实距离的 wz/hy ≈ 0.45，尾段 0.25。
   外侧最近距离偏小 → 解析覆盖率偏高，下沿外扩一圈半透明（约 900 像素 / 场景）；内侧深度偏浅 → W-EDGE 审查返工只好让整流罩内侧改走 RGSS，
   5 个样本、覆盖率 0.2 一档，近水平的下沿成了 1 px 台阶。
2. 尾端平切面用 `max(椭圆, 端面)` 组合，棱外的距离偏小（最多 1/√2）。
3. 尾端平切面几乎侧对视线时，弦里的距离场是「到端面的距离」一条平台：探测段 12 步走不到底就「放弃」（覆盖率 1，比参考高 0.16），
   「光滑凸面弦中点」的几何深度估计在这种不对称的棱上也系统性偏深。确定性序列里尾端竖边的覆盖率在 0.84 ↔ 0.36 之间跳（路径码 3 ↔ 2）。

## 改了什么（`wing.glsl.ts`）

- 椭圆距离取一阶精确的 f / |∇f|：`(k0 − 1) / max(|p/r²| / k0, 1/max(wz, hy))`（分母下限是 |∇f| 的数学下界，只防 p = 0 的 0/0）。
- 头 / 尾端面按挤出体的精确组合：`min(max(d, e), 0) + length(max(vec2(d, e), 0))`。零等值面不变（形状不变）。
- 去掉 W-EDGE 审查返工加的「整流罩内侧走 RGSS」例外，整流罩和其他部件一样走解析覆盖率。
- 整流罩的探测段：走满 12 步不放弃，按弦上最小值出解析覆盖率；深度只取最小值，不取几何估计。
- 其他部件的代码路径逐字不变（新分支都以 `w.part == 5` 为条件）。

## 数字

### 静帧（同页冻结，对 25 条子射线参考图；`PUB-5-mkjobs.py all --no-cand` + `W-EDGE-metrics.py`）

| 场景 | 边缘带差和 old → new | 外扩像素 old → new | 边缘带覆盖率误差 old → new | 非机翼逐位（old、new 覆盖率都为 0） |
| --- | --- | --- | --- | --- |
| noon-cumulus | 89661 → 66313（−26%） | 906 → 158 | 0.087 → 0.053 | 0 / 1805870 像素 |
| sunset-wing | 167532 → 127755（−24%） | 907 → 160 | 0.087 → 0.053 | 0 / 1806486 |
| route-hnd-cts | 94200 → 70330（−25%） | 884 → 199 | 0.088 → 0.054 | 0 / 1805555 |
| 夜间开频闪（night-wing-on，strobe 钉亮） | 35520 → 35389（持平） | 889 → 173 | 0.086 → 0.053 | 0 / 1806167 |
| 合计 | 386913 → 299787（−22.5%） | | | |

「新长出覆盖」每场景 3–5 像素，「消失」720–780 像素（就是旧版外扩的那一圈）。机翼内有变化的像素在 hdrWing 里约 4.3 万（夜间 3.3 万、最大差 7e-5），
显示值差 > 2 的 2–3 千像素，都在整流罩轮廓、整流罩本体（法线随距离场略变）与整流罩压在翼后缘上的内轮廓上（`tmp/pub5/dmap-*.png`）。

### 爬行指标（`flicker`，头部每帧 +0.06 mm、20 帧；`PUB-5-crawl.py` 分区，两轮一致到 ±0.00005）

| 场景 · 区域 | 爬行 old（5380） | 爬行 new（5305） | 每个会动像素的 |二阶差| old → new |
| --- | --- | --- | --- |
| noon · 整流罩区 620,560,200,120（PUB-3b 口径） | 0.00124 / 0.00123 | **0.00097 / 0.00096** | 2.18 → 1.90 |
| noon · 主翼后缘区 420,640,200,120 | 0.00051 / 0.00051 | 0.00050 / 0.00050 | 1.23 → 1.20 |
| noon · 中整流罩 675,625,95,60 | 0.00172 / 0.00167 | 0.00109 / 0.00113 | 2.09 → 1.80 |
| noon · 内整流罩 440,780,140,100 | 0.00194 / 0.00190 | 0.00169 / 0.00167 | 2.88 → 3.02 |
| sunset · 整流罩区 | 0.00463 / 0.00463 | 0.00369 / 0.00367 | 2.91 → 2.21 |
| sunset · 主翼后缘区 | 0.00256 / 0.00256 | 0.00256 / 0.00258 | 1.62 → 1.60 |
| sunset · 中整流罩 | 0.00476 / 0.00479 | 0.00333 / 0.00335 | 2.71 → 1.50 |
| route-hnd-cts · 整流罩区 | 0.00229 / 0.00231 | 0.00181 / 0.00178 | 3.60 → 2.82 |
| route-hnd-cts · 主翼后缘区 | 0.00146 / 0.00146 | 0.00148 / 0.00148 | 1.52 → 1.52 |
| route-hnd-cts · 中整流罩 | 0.00265 / 0.00251 | 0.00133 / 0.00136 | 4.98 → 2.13 |

**验收「整流罩区 ≤ 0.0006」没有达到**（noon 0.00124 → 0.00097，−22%）。说明：
- PUB-3b 的整流罩区里横穿一整条主翼后缘，外加上方外侧整流罩的尾端；这个裁剪区的轮廓长度约是主翼后缘区的两倍（会动像素 1231 对 967），
  即使整流罩的边和主翼后缘一样好，爬行指标也在 0.0008 左右。所以另报了「每个会动像素的 |二阶差|」：整流罩区 1.90、主翼后缘区 1.20，约 1.6 倍（旧版 1.8 倍）；
  中整流罩单看 noon 1.80、sunset 1.50、hnd 2.13（旧版 2.09 / 2.71 / 4.98）。
- 确定性序列（冻结后 head.x 每帧 0.06 mm、20 帧，noon 尾端 + 下沿，`tmp/pub5/sw3`）按覆盖率算：Σ|二阶差| old 238 → new 135（参考图 88），
  > 0.5 的跳变 232 → 0，> 0.25 的 297 → 28；下沿 91 → 51（参考 38），尾端 146 → 84（参考 50）。硬台阶（大跳变）已经没有了，
  剩下的主要是「探测 → 解析」这条路径的内侧系统偏浅（约 −0.1，所有部件都有，W-EDGE 已记）。
- 内整流罩（翼根侧、靠近机身）noon 的每像素值略升（2.88 → 3.02），但总爬行下降（外扩那圈消失、会动像素变少）；这一处主要是整流罩压在翼后缘上的内轮廓，仍走 RGSS（不是本任务改的路径）。
- 试过、没取：给整流罩内侧补 0.1 / 0.15 像素的深度（随深度渐入）→ 序列 Σ 141 → 159 / 161，更差；尾端棱倒 8 mm 圆角 → 尾端 Σ 83 → 77，但改几何、覆盖率误差略升。

### 飞行中（`ab live`，480 帧，old / old2 基线两轮、new / new2 本分支两轮；`wedgerev_mask.py` 按覆盖率掩码的「轮廓带 / 机翼内部 / 窗外」闪烁像素）

| 场景 · 区域 | old / old2 | new / new2 |
| --- | --- | --- |
| sunset · 后缘与整流罩 | 45/47/1285 · 35/32/1076 | 23/39/1206 · 44/38/1064 |
| sunset · 主翼前缘 | 20/586/0 · 68/406/0 | 114/393/0 · 98/332/0（带 + 内部合计 606/474 → 507/430，掩码划分随冻结时刻变） |
| sunset · 小翼前缘 / 后缘 | 26/175 · 29/137；0 · 0 | 27/156 · 17/174；0 · 0 |
| noon · 整流罩 | 0/1/8 · 0/1/6 | 2/0/24 · 2/0/9 |
| 商务舱正午 · 小翼前缘 / 主翼前缘（带内） | 715 · 637；54 · 88 | 719 · 713；46 · 48 |
| 夜间开频闪 · 翼尖灯与主翼前缘 / 小翼前缘 | 18/12 · 21/2；0/12 · 0/2 | 15/5 · 17/1；0/5 · 0/1 |

都在两轮噪声内，没有新的闪烁（这套统计阈值 8 级，量不出亚级的爬行，爬行看上一节）。

### 性能

- **冷编译**（离线 FXC，`shader-budget --baseline tmp/pub5-base --only wing,wing-wet --rounds 7 --wait-quiet`，CPU 2–15%）：
  wing 5585 → 5628 ms（**+0.8%**），wing-wet 6617 → 6628 ms（**+0.2%**）。
- **机翼 pass GPU**（`gpu-ab --time wing`，8 轮 ABBA，old2 = A/A，`handoff/PUB-5-gpu-jobs.json`，CPU 4–8%）：
  noon ×1.042（A/A ×1.000）、sunset ×1.038（A/A ×1.012）、route-hnd-cts ×1.026（A/A ×0.997）、云里湿窗 ×1.036（A/A ×0.994），
  即每帧 +0.02–0.03 ms。来源：`sdWingFairing` 在求交循环每步都算（两份 `wingCanoe`），多了一次 length 与除法；整流罩像素从 RGSS 改解析省下的抵不过。

### 其他

- typecheck、`pnpm --filter voyage build`、`find dist/assets -type f -size 0`（0 个）、`check:glsl` 全部通过；`dev-browser check` 无 console error。

## 裁图（上 old、中 new、下 25 子射线参考图；最近邻放大）

在 `D:\Code\opus-test\tmp\screenshot\PUB-5\`（工作区忽略目录，不进仓库）：
- `hnd-mid-fairing.png` / `hnd-inner-fairing.png`：首屏 route-hnd-cts，×6 / ×5；
- `sun-mid-fairing.png` / `sun-inner-fairing.png`：sunset-wing；
- `night-mid-fairing.png` / `night-inner-fairing.png`：夜间开频闪（整流罩几乎不可见，新旧无差别）；
- `noon-*.png`：noon-cumulus（PUB-3b 的测量场景）。

新版下沿的台阶和外扩的一圈浅色没了、尾端竖边与参考图对齐；旧版下沿每隔十几个像素一个 1 px 台阶。

## 复现

```
# 在 worktree 根
python apps/voyage/handoff/PUB-5-mkjobs.py tmp/pub5/jobs-all.json all --no-cand     # 静帧（去掉 --no-cand 时还带候选补丁，要在 master 原文上用）
node apps/voyage/scripts/dev-browser.mjs ab --port <开发> --base <对照> --jobs tmp/pub5/jobs-all.json --rounds 1 --out tmp/pub5/final
python apps/voyage/handoff/W-EDGE-metrics.py tmp/pub5/final old,new
python apps/voyage/handoff/PUB-5-zoom.py 输出.png 660,615,110,80 6 tmp/pub5/final/sun/old.png tmp/pub5/final/sun/new.png tmp/pub5/final/sun/ref.png
# 爬行（两个端口各跑，帧留在 --out）
node apps/voyage/scripts/dev-browser.mjs flicker --port <端口> --only noon-cumulus --out tmp/pub5/fx
python apps/voyage/handoff/PUB-5-crawl.py tmp/pub5/fx 整流罩=620,560,200,120 主翼后缘=420,640,200,120 中整流罩=675,625,95,60
# 确定性序列 + 路径码（裁剪 y 是 GL 坐标：自下而上）
WEDGE_JOBS=tmp/pub5/jobs-noon.json python apps/voyage/handoff/W-EDGE-sweep-mk.py tmp/pub5/sweep.json noon 20 0.06 660,520,100,60 [额外变体.json]
node apps/voyage/scripts/dev-browser.mjs ab --port <开发> --base <对照> --jobs tmp/pub5/sweep.json --rounds 1 --out tmp/pub5/sw
PYTHONUTF8=1 python apps/voyage/handoff/W-EDGE-sweep-ana.py tmp/pub5/sw/noon/dump.json 尾端=64,0,20,60 下沿=0,0,64,60
# GPU / 冷编译
node apps/voyage/scripts/dev-browser.mjs gpu-ab --port <开发> --base <对照> --jobs apps/voyage/handoff/PUB-5-gpu-jobs.json --rounds 8 --time wing
node apps/voyage/scripts/shader-budget.mjs --baseline <对照 worktree> --only wing,wing-wet --rounds 7 --wait-quiet
```
（`jobs-noon.json` = `PUB-5-mkjobs.py ... noon`；live 用的是 W-EDGE 审查的 `live.json` 加一个 noon-live job，掩码统计脚本 `wedgerev_mask.py` 不在仓库里，见 `W-EDGE.md`。）
