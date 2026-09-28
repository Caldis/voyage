# SPEC-RAYS · 云隙光 / 曙暮光条 / 俯视云影暗柱

分支 `worktree-agent-a148424e65b711419`，端口 5265（对照 5325）。已合并 master（含 C-TOFU）。

## 结论

- 新增 `src/atmosphere/rays.ts`：独立的三个小 pass，**不碰窗外主程序**。做法是沿视线在云顶以下的空气里查已有的云影图（T27），
  算出被云挡掉的那部分**单次散射** ΔL，从 hdrOutside 里减掉，写成新的目标，舱内合成改读它。
- 看得见的效果：
  - 低太阳、云缝之间：云底下出现竖向的明暗光条（rays-gap-low），被云挡住的近处空气不再发橙色辉光；
  - 高空俯看、夕阳时：云影投进下方霾层，形成蓝灰色的暗块和暗条（sunset-wing、rays-towering-sunset）；层积云缝里的海面变成深蓝（sea-sc-low，和真实航拍一致）；
  - 在云底下逆光（backlit-close）：头顶那块云的影子罩住近处的空气，能看到远处受光霾带的边界（「影墙」）；
  - 反曙暮光：对日方向（rays-anti）有淡淡的暗条，量级与前向散射弱相符。
- 不该出现时逐位不变：夜里（主光源是月亮）、太阳 < −4°、没有云、云影图没建好、程序没编好，都直接返回原 hdrOutside。
  同页冻结 ab 实测 night-sea-milkyway、night-sea-fullmoon、dusk-earthshadow、low-sea-glint、正午晴空，开 / 关**逐位 0 差**（阳性对照 sunset-wing 平均差 2.0、最大 45）。

## 方案比较

| | A 体积：沿视线查云影图（采用） | B 屏幕空间径向模糊（Mitchell 2007，未实现，只做分析） |
| --- | --- | --- |
| 原理 | 每条视线在云顶以下步进，每步查云影图得阳光可见度 V，累计 (1 − V) × 单次散射，从 LUT 的内散射里减掉 | 以太阳在屏幕上的位置为中心，沿径向对「天空亮 / 云暗」遮罩做累加模糊，叠加亮条 |
| 太阳不在窗里 | 照样有（窗很窄，太阳大部分时间不在画面里） | 没有（或要硬造一个屏幕外中心，光条方向只能靠猜） |
| 高空俯看云影投在霾里 | 有：影子是世界空间的体积，从上往下看自然是暗柱 | 做不到：没有深度 / 世界位置 |
| 反曙暮光 | 自动有 | 没有 |
| 视差 / 头动 / 飞行 | 光条固定在世界里，跟云一起走 | 贴在屏幕上，头一动整片光条跟着甩 |
| 颜色 / 亮度 | 物理：影子里剩天光（多次散射），暗条偏灰蓝；与大气 LUT 同一套介质参数 | 艺术参数，容易发白、像镜头特效 |
| 代价（3840×1950，RTX 5090） | 三个 pass 合计约 0.1–0.2 ms（见下） | 约 0.05 ms 量级 |

真实感上 A 明显更好（B 的典型毛病是「镜头特效感」「头动时光条跟着屏幕走」），而 A 的代价已经在预算内，所以只实现 A。

## 实现要点（rays.ts）

1. **步进**（1/4 分辨率，48 步）：视线与「海面—云顶」这一段求交（云顶以上的空气不可能在影子里，巡航高度朝天看的像素直接返回 0）；
   步进起点按 4×4 Bayer 矩阵错开（固定在屏幕上，不随时间变 → 不闪）；每步 `cloudShadow` 查云影图，
   3 km 以上的点在云底（≥3 km）—云顶之间渐变回 1（云影图只存 0/1/2/3 km 起点）。
   同时按「云壳入口」把 ΔL 拆成近 / 远两份（A 通道存远的比例），云挡在前面时远的那份乘云的透射率。
2. **4×4 盒式模糊**（4 次双线性取样）：任何 4×4 窗口里 16 个错开相位各出现一次，等效 16×48 个分层样本，没有条带和固定噪点。
3. **合成**（全分辨率）：读 hdrOutside、双线性上采样 ΔL、读云缓冲透射率，减掉 ΔL × 太阳照度 × 窗板透射率，
   三通道共用一个缩放 k、最多减 90%（逐通道夹会出紫点，见 README 坑点）。alpha（1 + 点星可见度）原样保留。
4. **按需后台编译**：首帧后 60 帧（或想要时第 3 帧起）`compileAsync`，编好前不画；不在启动批次里。页面实测编译 356 ms。

## 数字

GPU 计时（`await __voyage.rays.bench(__voyage.hdrOutside, 20, part)`，EXT_disjoint_timer_query；9 轮 × 20 次，3840×1950，负载下，取最小 / 中位）：

| 场景 | 全部 | 步进（32 步、1/4） | 模糊 | 合成 |
| --- | --- | --- | --- | --- |
| sunset-wing | 0.17 / 0.26 | 0.039 / 0.040 | 0.002 | 0.072 / 0.157 |
| noon-cumulus | 0.15 / 0.29 | 0.024 / 0.027 | 0.002 | 0.062 / 0.072 |
| backlit-close | 0.17 / 0.32 | 0.031 / 0.035 | 0.002 | 0.062 / 0.073 |

定稿用 48 步（步进 ×1.5，约 +0.02 ms），合计约 0.1–0.15 ms（最小值），在「≤ +0.5 ms」内。
试过 1/2 分辨率 + 48 步：步进涨到 0.15–0.2 ms、合计 0.33–0.5 ms，同页对照画面几乎看不出差别（光条本来就软），没采用。
整帧 `gpu-ab --time frame`（8 轮 ABBA）在并行负载下离散 6–20%，开 / 关都判「在离散度内」，不作结论。

飞行中闪烁（`ab` 的 `live`，360 帧，二阶差分阈值 8 级）：

| 场景 / 区域 | off | on | off2 | on2 |
| --- | --- | --- | --- | --- |
| sunset-wing 霾层 闪烁像素 / 每帧超阈值 | 4971 / 868 | 8862 / 1282 | 4645 / 773 | 8330 / 1213 |
| backlit-close 影墙与海面 | 262 / 79 | 706 / 149 | 423 / 107 | 796 / 160 |

开了以后闪烁像素多，**来源不是光条本身**：海面上原来盖着一层均匀的霾辉光，减掉后海浪 / 耀斑的反差变大，
原本就在动的海浪更多地超过阈值。直接量 ΔL 自己的时间稳定性（`handoff/SPEC-RAYS-dl-live.js`：解冻飞行 150 帧，逐帧读回模糊后的 ΔL）：
相对二阶差分 0.015–0.045%，相对 2% 以上的纹素 0.002–0.17%——光条本身不闪、不爬。

冷编译：不改任何共用 GLSL，窗外 / 舱内 / 云 / 机翼程序文本不变；三个新程序后台编译，不进关键路径。

## 截图（worktree 的 `tmp/screenshot/SPEC-RAYS/`，已忽略）

- `final/*.png`：左关右开（不冻结、各自曝光与色适应），场景见 `handoff/SPEC-RAYS-scenes.json`：
  sunset-wing、backlit-close、rays-gap-low（0.5 km、云缝、逆光）、rays-shadow-haze（巡航、太阳 20°）、
  rays-towering-sunset、rays-anti（背对夕阳）、sea-sc-low、noon-cumulus、dusk-earthshadow。
- `ab1/`：不该出现时的逐位对照；`live1/`：飞行中录制；`ds/m.png`：1/4 与 1/2 分辨率同页对照；`diag1/`：云影可见度诊断。

## 复现

```
node scripts/dev-browser.mjs shots --port 5265 --scenes-file apps/voyage/handoff/SPEC-RAYS-scenes.json --freeze --out tmp/screenshot/SPEC-RAYS/on
node scripts/dev-browser.mjs shots --port 5265 --scenes-file apps/voyage/handoff/SPEC-RAYS-scenes.json --freeze --query "rays=0" --out tmp/screenshot/SPEC-RAYS/off
node scripts/dev-browser.mjs ab --port 5265 --jobs apps/voyage/handoff/SPEC-RAYS-ab-jobs.json --variants apps/voyage/handoff/SPEC-RAYS-ab-variants.json
node scripts/dev-browser.mjs ab --port 5265 --jobs apps/voyage/handoff/SPEC-RAYS-live-jobs.json
node scripts/dev-browser.mjs shots --port 5265 --only sunset-wing --viewport 2560x1300 --dpr 1.5 --pair "$(cat handoff/SPEC-RAYS-bench.js)" --pair "return 0"
```

## 协调者接入 / 归属外改动

- `src/main.ts`（热点，最少行）：import、构造 `rays`、`resize` 里 `rays.setSize`、窗外 pass 之后 `u.uOutside.value = rays.render(hdrOutside)`、
  `benchScene` 里同样一行、`__voyage.rays`。
- `scripts/lint-shaders.mjs`（归属外，一小段）：新增 `rays` 一节，把三个程序纳入 check:glsl。
- README：模块表一行、渲染管线一行、「大气与曝光」坑点一条。
- 面板开关没做（按简报等 UX-1a 合并后再加）；调试用 `__voyage.rays.enabled` / `?rays=0`。

## 已知问题 / 下一步

- 颜色取向：夕阳下影子里的霾减掉暖色单次散射后偏蓝（物理上暗条就是蓝灰色），加上舱内色适应，个别画面（backlit-close）海面显得偏饱和的深蓝，建议美术总监看一眼；
  要收敛可以只减一部分（`uRaysGain`）或只在霾里减，但目前按物理量交付。
- 浓积云 / 雷暴云层内部（3 km 以上）的空气用近似（渐变回 1），塔与塔之间的光条弱于真实；要准需要云影图多存几层起点高度。
- 月光的云隙光没做（夜里整段关闭）。
- 云影图最外一级 400 km、太阳低于约 3° 时云影图本身的路径上限（30 km）会让地平线附近的光条变短。
