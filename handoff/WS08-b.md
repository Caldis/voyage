# WS08-b · 天环夜灯「方格斑」+ 奇观地影交界半影（交接）

分支 `worktree-agent-ae414e7d6e751b6dd`（已合并 master 999b5ef），端口 5296，对照 master 5366。状态：**已交付**。
截图都在 **worktree 内** `tmp/screenshot/WS08-b/`：`base/`（master）、`final/`（本分支）原图，`cmp-*.png` 为左 master / 右本分支的裁图对照（`-x3` / `-x4` 为最近邻放大）。
环境：私有 headless，`GL_RENDERER = ANGLE (NVIDIA GeForce RTX 5090 … D3D11)`，1600×1200，画质 high，URL 带 `voyage=0`；ab / gpu-ab 持测量锁。

## 改了什么

1. **夜灯（`src/wonders/ring.glsl.ts`）**
   - 城区疏密 `ringCity(q, f)`：60–70 km 的域扭曲 + 46 / 21 / 9.7 / 4.5 km 四个倍频，每级转 37°、错开相位，格子方向互不对齐；采样不住的倍频（f / λ > 0.18–0.42）淡到均值，淡掉部分的起伏按标准差放宽阈值（过滤后的阈值）。取代原来一层 28 × 20 km value noise + smoothstep（方格斑的来源）。
   - 灯团：`ringLampPts` 加参数 `lv`，一格 8·2^lv km。lv = 0 就是原来的单盏灯；lv ≥ 1 的一团代表格里 4^lv 盏灯，出现概率 2p̄（p̄ = 这一格按格大小过滤的平均有灯概率，城区上限 1），能量 ÷ 概率——期望与单盏灯逐级相等。格子在屏幕上小于约 3 像素（3·足迹 > 格边）就升一级，相邻两级按足迹线性混合（一个循环、一个调用点）。有没有灯团只由世界坐标决定。删除了原来「足迹 > 2–3.6 km 换成平均面亮度」那一路。
   - 枢纽另加一层按足迹平均的暖白底光（0.35·0.64/64），夜里枢纽仍是一格格亮的舱段。
2. **地影半影（新文件 `src/wonders/penumbra.glsl.ts`，按前缀生成 `ringShadowT` / `pillarShadowT`）**
   - 日面弓形遮挡（面积比 f、透射率取弓形形心光线的）；大气折射压扁日面：近地点高度差 = 2θ / (1/D + 0.02/7.5·e^{−h/7.5})，交界处 2–3 km（天环 D ≈ 3000 km、巨柱 D ≈ 600 km 都是这个量级）；近地点 0–8 km 的低层云 / 霾渐隐。交界位置与原来相同；近地点 > 8 km 且整个日面露出时返回值与原来逐值相同。
   - 输出 `vis = √(f·cl)` 与 `tRef`（云层顶以上的透射率 × vis）。调用方（天环环体 / 缆塔、巨柱群柱身 / 柱脚云）封顶比例按 tRef 定，并把「有太阳」与「只有月光 / 天光 / 地球反光」两份封顶结果按 vis 混合。
   - 硬线的根因是亮度封顶把半影里的衰减抵掉了（见 README 新坑点），不是单纯缺半影。
3. `src/wonders/pillars.glsl.ts`：`wonderLightT` → `pillarShadowT`；Ls / Lref 拆出 LsR / LrefR（`wonderIrr` 对照度线性，减掉太阳项即可），两次 `wonderCapRef` 按 visS 混。云团同样处理。
4. README 奇观坑点 +3 条（封顶才是硬线根因；弓形面积浮点负数 → NaN 整帧刷白；远处平均面亮度 → 灯团）。

默认 / OW / DOW / DROW **预处理后逐字不变**：`shader-parity --base <master 树>` 只有 `outside-pillars`、`outside-ring` 两个程序不同，其余 57 个逐字相同（outside-default / extras / ground-detail / rail 为「预处理后逐字相同」）。天梯 / 建木仍用 `wonderLightT`，未碰。

## 画面对照（左 master / 右本分支）

| 场景 | 对照图 | 结论 |
| --- | --- | --- |
| `ws08-night-nm-up` | `cmp-night.png`、`cmp-night-mid-x3.png`、`cmp-night-far-x3.png` | 方格状粉灰斑消失；中远段是一粒粒橙色灯（灯团），疏密成片、边界不沿网格，放大 3 倍看不到格子与柔边色块；枢纽仍是亮的舱段 |
| `ws08-dusk-nm-up` | `cmp-dusk-nm.png` | 同上（地影段只剩灯） |
| `ws08-dusk-up` | `cmp-dusk.png`、`cmp-dusk-edge-x4.png` | 受光段、红带与 master 逐像素几乎一致；交界从 1 像素硬切（亮度 175 → 95 → 40）变成约 5 像素的暗红过渡（183 → 181 → 173 → 138 → 93 → 54 → 39，第 820 列）；地影段淡方块换成灯点 |
| `ws-pillars-dusk` | `cmp-pillars.png`、`cmp-pillars-x3.png` | 一像素横切线消失：粉色柱顶往下约 25–30 像素（约 5–8 km）渐暗、偏暗红后没入地影的蓝灰，没有比地影还暗的带；柱顶受光段与 master 相同 |
| `ws08-noon`（回归检查） | `cmp-noon.png` | 与 master 一致 |

说明：天环在 1000–2000 km 外，交界处近地点每像素约 5 km（调试时输出 `fract(近地点/5)` 条纹实测），物理半影（2–3 km）+ 云层渐隐（8 km）合起来只有 3–5 像素——比原来软，但不是几十像素的大渐变；再宽就不物理了。巨柱群 190 km 外同样的物理量是 25–30 像素。

## 闪烁（`ab` 的 `job.live`：解冻飞行 240 帧，二阶差分阈值 16、帧占比 > 5% 算闪烁像素；`handoff/WS08-b-live-jobs.json`）

| 场景 | 区域 | master on / on2 / off | 本分支 on / on2 / off |
| --- | --- | --- | --- |
| 黄昏仰看 `ws08-dusk-up` | 受光段 / 交界与地影段 | 0 / 0、0 / 0、0 / 0 | 0 / 0、0 / 0、0 / 0 |
| 无月夜 `ws08-night-nm-up` | 近段灯 / 远段 | 5 / 0、14 / 0、0 / 0 | 0 / 0、0 / 0、10 / 0 |
| 巨柱群黄昏 `ws-pillars-dusk` | 交界带 / 柱身 | 0 / 0、0 / 0 | 0 / 0、0 / 0 |

都在同代码两次的噪声底以内（夜里 master 同代码 5 vs 14、本分支 off 变体也有 10，都是背景星 / 头部晃动的残余）。
另：第一轮 live 抓到**黄昏 240 帧里 6 帧整幅刷白**（平均亮度 52 → 234），根因是弓形面积在 x → −1 时浮点出负数、sqrt 出 NaN；加 `max(…, 0)` 后复测 0 帧（逐帧平均亮度 52.2–52.3）。冻结截图完全看不出这个问题。

## 性能（`gpu-ab --time frame --rounds 8`，开 / 开（A/A）/ 关；`handoff/WS08-b-gpu-jobs.json`）

| 场景 | 本分支 开 ms | A/A | 在场增量（开 − 关） | master 在场增量 |
| --- | ---: | --- | ---: | ---: |
| 黄昏仰看 | 1.371 | ×1.006 [0.984, 1.009] | +0.064 ms | +0.058 ms |
| 无月夜 | 1.624 | ×0.999 [0.990, 1.007] | +0.114 ms | +0.017 ms |
| 巨柱群黄昏 | 2.120 | ×1.006 [0.986, 1.012] | +0.314 ms | +0.349 ms |

全部 ≤ +0.6 ms。夜里多约 0.1 ms（灯团两级 × 4 格的城区噪声）。并行开发负载下测的。

## 自检

- `pnpm --filter voyage typecheck`、`check:glsl`（全部通过，含「只有 outside-ring 含天环代码」断言）、`pnpm --filter voyage build`，`find apps/voyage/dist/assets -type f -size 0` 无输出。
- 所有 shots / ab / gpu-ab 期间 console error 0。
- 冷编译未测（未新增程序；OWT / OWP 是按需后台编译，不在冷启动关键路径）。灯团循环是固定 2 × 4 次，`ringCity` 每次 6 个 vnoise，OWT 的离线 FXC 可能比原来略长，建议波次收尾统一测一次。

## 遗留

- 巨柱群交界的色调是「粉 → 暗紫 → 地影蓝灰」，红得不算深；想更「深红」可以把封顶的色相从 T(he) 取（现在亮度与色相都按比例混）。
- 天环夜里月光 / 地球反照照亮的段（有月夜、黄昏）没有专门看，只看了回归三张 + noon。
- 半影只进了太阳一路；月亮的地影（月光照亮环时）仍用同一个函数，视半径按太阳算（差不多）。
- NIGHT-AP-1 若把奇观着色里的 `uSunDir` 换成 `uApDir`，只影响空气透视查表那几行；本任务的改动集中在光照 / 封顶，合并时预计无冲突（本次合并 master 999b5ef 时 master 还没有该改动）。

## 怎么复现

```bash
pnpm -C apps/voyage exec vite --port 5296 --strictPort --host 127.0.0.1
node apps/voyage/scripts/dev-browser.mjs shots --port 5296 --query voyage=0 --freeze --scenes-file apps/voyage/handoff/WS08-b-scenes.json --out tmp/screenshot/WS08-b/final
python apps/voyage/handoff/WS08-b-crop.py 输出.png 740,650,140,90 4 master图.png 本分支图.png   # 对照裁图
node apps/voyage/scripts/dev-browser.mjs ab --port 5296 --query voyage=0 --jobs apps/voyage/handoff/WS08-b-live-jobs.json --out tmp/screenshot/WS08-b/ab-live
node apps/voyage/scripts/dev-browser.mjs gpu-ab --port 5296 --query voyage=0 --jobs apps/voyage/handoff/WS08-b-gpu-jobs.json --rounds 8 --time frame
node apps/voyage/scripts/shader-parity.mjs --base <master 树>          # 在 apps/voyage 下
```
