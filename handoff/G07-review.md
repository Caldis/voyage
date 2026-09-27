# G07 独立审查

对象：分支 `worktree-agent-a3f4b4129ac333f16`（b09ee0a），范围 `git diff master...worktree-agent-a3f4b4129ac333f16`。
复核环境：`tmp/g07rev`（master dc74a5e + `merge --no-commit` 本分支，已删除），端口 5216，RTX 5090 / ANGLE d3d11 / 1600×1200 / DPR 1 / 120 Hz，自动档 → 高，地面 2048（依据「高性能独显」）。
截图、数据和审查脚本放在 `tmp/screenshot/g07rev/`（脚本在 `scripts/` 子目录，其中 `g07rev-spikes4/5.mjs`、`g07rev-rate60.mjs`、`g07rev-recenter.mjs` 放回任意 worktree 的 `apps/voyage/handoff/` 下就能跑）。

## 结论：通过

本任务的主要收益都已复现，而且站得住：

- 重建时整级错位闪烁已修好。同页逐帧 readPixels，旧做法（`stagedUpload = false`）每次重建出现 2 帧尖峰，平均差 0.158–0.166；G07 全程最大差 0（是 0，不是很小）。这是「闪烁优先」一类的真缺陷。
- 白天首载先粗后细：fuji-day 粗版全部可用用了 8.5 s，全部升级完 16.4 s，EOX 请求 685 条。夜里确实跳过这条路径：night-city 从第一级起就是 fine，13.3 s 全部就位。
- mip 的 A 编码正确。
- 60× 下没有积压。

有一个没能消掉、并且复现到的疑点：1× 下 > 16.7 ms 的帧，G07 做法大约多 1.7 倍（见 M1）。机理没查清，这台机器上幅度也小，不挡合并，建议另开任务。其余问题都是中低级，可以合并后顺手修，也可以在合并前花 10 分钟修掉 L1–L3。

零冲突：本分支与 C12（`a494668…`）、T48b（`a915f01…`）、W-STAIR（`abbe8a3…`）的 `git merge-tree` 全部干净，文件没有交集。typecheck、build（dist 无 0 字节）、`check:glsl`、`dev-browser check`（2048 与 `?groundres=1024` 两档）都通过，没有 console error。

---

## 逐项核查

### 1. mip 的 A 通道：正确，与夜城 / T48b 无交互

- **读 A 的着色器路径全部查过**（`rg "(texture|textureLod|textureGrad|texelFetch)\s*\(\s*uGround"`，再加上 `groundSampleImpl` / `groundSampleAniso` 的调用点）：
  - `groundRoadTap`：影像 A 当道路宽度、水体 A 当有向距离读，`groundRoadCoverage` 的梯度三次取样读水体 A。这几处全是 `textureLod(…, 0.0)`，只读第 0 级，不受 mip 影响。
  - `groundSampleAniso`（`textureGrad`，会读到 mip）只在 `holes` 时用 A，算 `min(A·2, 1)`。它的返回值是 `vec4(rgb, 1.0)`，A 不外传。调用方 terrain-shading 75/77/80 行拿到的 `alb.a` 恒为 1。
  - `groundSampleImpl`（textureLod 0）：far-view、terrain-shading 146 行（太阳方向偏移取样）、ground-detail 259 行（水体 `.r`），都不经过 mip。
  - 结论：没有任何路径会在 mip 级把 A 当成宽度或距离解码。
- **编码离线复核**（`scripts/g07rev-rules.mts`，16² 人工图，左半「有影像 + 路（A = 128 / 255）」，中间「A = 64」，右半「A = 0」）：各级 A 分别为 128 → cov 1、64 → 0.502、32 → 0.251，1×1 这一级是 80 → 0.627，等于 (1 + 0.251) / 2。按宽度误读也恒为 0。比 G06 的 GPU 平均更准：有路纹素 A ≈ 1 不再把覆盖比例抬高。
- **与 BIS-7 / T48b（夜城 exposure）**：G07 没碰着色器，也没碰 exposure。夜间灯点按影像 RGB 判建成区，mip 的 RGB 在线性空间平均，和 GPU 对 sRGB 纹理生成 mip 的做法相同（实现者同页 A/B 的 night-city 最大差只有 2）。所以 T48b 看到的问题不是 G07 引起的。
  - 需要注意的交互：1024 档机器（Mac 的基础款 M 芯片、Safari）的夜景和 2048 档不完全一样。我在同一分支上拍了两档对比：night-city 平均差 2.95，p99 47；hnd-cts-night 平均差 2.48，p99 56；区域平均亮度 95.8 对 96.5、73.5 对 71.0。整体亮度一致，灯点排布不同，见 `night-city-2048-vs-1024.png`。**建议 T48b 验收时加一张 `?groundres=1024` 的夜景**，因为用户的 Mac 很可能落在 1024 档。

### 2. 暂存缓冲原子换上：正确

- **确实在同一帧**：`drainStaged` 的最后一步里，`texSubImage3D`（第 0 级 + mip，源是 PBO）→ 高度走 three 的 `upload`（`needsUpdate`，在这一帧的 render 里上传）→ `batch.after()` 换中心 uniform，同步执行完，中间没有 await 和 rAF。`update()`（main.ts 530 行）在渲染之前调用。逐帧读回的实测：G07 最大差 0，旧做法 4 个尖峰（每次重建 2 个）。
- **重建中途再次触发重建**：同一级有 `l.building` 串行，排进上传队列后要等 `after` 才清，所以队列里同一级最多一批。PBO 只由队首一批写，写完、拷完、`shift()` 之后下一批才 `makePlan`，不会拷进半成品。`reset()` 清空队列，旧 plan 随之丢弃，下一批从偏移 0 重写。`setMinLevel` 中途生效时，拷贝照做，`after` 按 `i < minLevel` 不启用，没有问题。唯一的代价是 60× 时某级换上的可能已是过时中心、随即再建一次，这是 PERF-8 起就有的行为。
- **失败回退**：没接 GL、`glTex` 缺失、`createBuffer` 失败、上下文丢失，这几种情况下 `drainStaged` 都返回 false，交给 PERF-8 的逐帧路径。`batch.jobs` 只在最后拷贝完成的那一帧才清空，所以半途回退也能把 3 张传全。高度纹理仍走 `upload()`，TR03 的半精度回退（`floatHeight` 为 false 时转 half）原样保留。
- **显存**：PBO 大小 = 2 × (16 MB + 5.33 MB) = 44.7 MB，只增不减，1024 档是 11.2 MB。与交接一致，可以接受。
- **换上那一帧的代价**（`G07-spikes.mjs` 实测）：commit 帧主线程最多 2.1–2.7 ms，commit 帧间隔 8.1–8.6 ms，没有掉帧。这是 ANGLE D3D11 上的结果。ANGLE Metal（Mac）从 PBO 拷的路径不同，测不了，见 L4。

### 3. 先粗后细：行为正确，升级跳变可以接受

- 白天 fuji-day 复测：粗版 8.5 s，全部 fine 16.4 s；每次升级相邻两帧的平均差 0.02–0.23，p99 ≤ 5.7。拿 `06-v7-f0.png` 和 `11-v7-f7.png` 对比，粗版阶段近处海岸城区明显偏糊，持续约 8 s。糊到什么程度：相当于 G06 之前的清晰度，比 master 同一时刻（级别还没就位、退到更粗的级别）清楚，所以不算违反「宁可有雾不露低清」。升级是按级「一下变清楚」，运动相机下和平时一级重建换上的观感相同（换上是原子的，没有错位）。
- **黄昏跨阈值**：`updateWarm` 在 `sunY < sin 6°` 时直接把 warm 置 true，之后所有非 fine 的级别按 fine 重建。灯点在 `uSunDir.y > 0.06`（约 3.4°）时恒为 0，所以只要升级在太阳从 6° 降到 3.4° 之前做完（1× 时间下有十几分钟，升级只要约 8 s），灯光就不会「换一版」。只有时间流速开得很大、恰好在首载的 8 s 内跨过 6° → 3.4°，才可能看到一次灯光换版。属于极端边界，记录即可（L5）。
- night-city 复测：第一级起 `fine = 1`，没有粗版阶段。

### 4. GPU 启动定档

- **临时上下文释放**：`getExtension("WEBGL_lose_context")?.loseContext()` 写法正确。WebGL 上下文上限按页面计（Chrome 16 个），释放后不占名额。只有在 `getParameter` 抛异常时才会漏掉释放，概率极低。Safari 支持这个扩展。
- **规则**：实现者的 21 条全过。我另加了 22 条（`g07rev-rules.mts`），发现几个边界：
  - 偏宽，弱独显被判成 2048：GTX 1060 3 GB 被归为 2048 可以接受；Radeon RX 550、Radeon Pro 555X（2018 款 MBP）、Quadro T1000、Arc A370M 这类入门独显也会走 2048。
  - 偏严，强卡被判成 1024：GTX 980 Ti、Quadro P5000。
  - 双显卡 Mac（Intel + Radeon Pro）：探测上下文用的是默认 `powerPreference`，会拿到 Intel 核显，判成 1024；主渲染器却是 `high-performance`。建议探测也传 `{ powerPreference: "high-performance" }`（L2）。
  - Safari：渲染器字符串一律是 `Apple GPU`，所以任何 Mac 在 Safari 里都是 1024。Chrome 下 M Pro / Max / Ultra 判 2048，基础款 M 芯片判 1024。
  - 以上都是保守一侧或影响很小，不挡合并。
- **持久化手动档**：这改变了 PERF-5 的行为，是本次最该协调者拍板的一点，见 M2。

### 5. 性能

- **60× 有没有积压**（`g07rev-rate60.mjs`，同页交替 2 × 2 × 45 s，minLevel = 3）：两种做法 Worker 忙碌率都是 0.77–0.85；build 从开始到排进上传队列的中位数，G06 做法 1046–1619 ms、G07 1070–1220 ms；各级中心平均落后 1.21–2.08 个挪动步长，G07 不比 G06 差；上传队列最长都是 1。**没有积压**。EOX 抖动远大于每级约 57 ms 的 mip 开销。
- **1× 的 > 16.7 ms 帧**：见 M1。

### 6. main.ts 一行接线

`ground.attachGl(renderer)` 正确，`resize` / `quality` 的初始化顺序也没问题：QualityController 构造时如果恢复手动档，会调 `applyLevel()` → `resize()`；`resize` 是函数声明，在 356 行之前已经执行过一次。`ui.ts` 的 `qualitySel.value = quality.tier` 会让面板显示恢复后的档位。

---

## 问题（按严重度）

### M1（中，不挡合并，另开任务）：1× 下 > 16.7 ms 的帧 G07 做法约多 1.7 倍，全部锚在 Worker 任务开头

证据（同页交替，每个窗口 45–60 s，hnd-cts，1× 连续航程）：

| 测量 | G06 做法 | G07 做法 | 另两种拆分组合 |
| --- | --- | --- | --- |
| `G07-spikes.mjs 60 3 1`（3 对） | 5 | 11 | — |
| `g07rev-spikes4.mjs 45 2`（4 种组合各 2 窗） | 5 | 4 | Worker mip + 每帧直传：**14**；GPU 整组 mip + 暂存：4 |
| `g07rev-spikes5.mjs 60 4`（4 对，开跑时测量锁被别人持有，已交替抵消） | 10 | 19 | — |
| 合计（约 13 分钟 / 边） | **20** | **34** | |

- **和上传无关**：落在上传帧前后 50 ms 内的尖峰，G06 做法 1 个，G07 做法 0 个。
- **全部落在 Worker 忙碌的区间里**（spikes4：27 个尖峰里有 26 个），而 Worker 只有约 25% 的时间在忙。spikes5 记录了尖峰在 Worker 窗口里的位置：**都在窗口开始后 13–77 ms**，离窗口结束还有 350–660 ms。这正是 Worker 刚开始、把 ImageBitmap 读回像素（GPU 进程同步读回 16 MB）的阶段，不在末尾的 mip 计算或转移阶段。
- 两种做法都有尖峰，所以根子是 G06 起就有的「Worker 读回位图」；「1× 帧间隔回到 0」这条验收两种做法都达不到。
- 拆分组合的数据隐约指向「Worker 算 mip」（14 对 4），而不是暂存。但尖峰在窗口开头、mip 在窗口末尾，机理说不通，计数也小（z ≈ 1.9），我**不能下结论**。
- 幅度：每个尖峰 23–47 ms（120 Hz 下掉 2–5 个 vsync），G07 约 2.5 次 / 分钟，G06 约 1.5 次 / 分钟。
- 建议另开任务（性能工程师，安静窗口）：
  1. 在安静窗口用 `g07rev-spikes5.mjs 60 6` 复测，确认差异是否真实；
  2. 低成本假设：`mips.ts` 每级新分配约 21 MB 的 Float32Array 临时缓冲，Worker 的 GC 可能恰好落在下一个任务的读回阶段。改成模块级复用缓冲再测一次；
  3. 根治方向是读回本身：Worker 里 `drawImage` + `getImageData` 16 MB。可以分块读，或者把影像合成挪到 GPU 上，不读回。

### M2（中，请协调者 / 用户拍板）：手动档持久化，并把「云档」和「地面精度」绑在一起

- 行为变化：以前每次载入都从「自动」起步（PERF-5）；现在只要手动选过一次「高 / 中 / 低」，之后每次载入都固定在这一档，云的自适应也跟着关掉。另外「中 / 低」会把地面降到 1024，「高」会强制 2048。
- 对用户的影响：
  - Windows 5090：如果为了看云选过「中」，之后每次载入地面都是 1024，清晰度掉一半。能看到的提示只有面板状态行的「地面 1024²」，不打开面板就不知道。
  - Mac：Safari 下自动判定恒为 1024。想要 2048 只能选「高」，代价是云固定全分辨率、失去自动降档，这在弱 GPU 上正是 PERF-5 要避免的。
- 实现者这样做有它的理由：自动档运行时升降不能改地面精度，面板和地面也需要一致。
- 建议把两者解耦：
  - 地面精度只看 `?groundres=` 和 GPU 自动判定，另加一个独立的持久化开关，例如面板上一个「地面精度：自动 / 2048 / 1024」小选项，或 localStorage `voyage.groundRes`；
  - 画质档恢复 PERF-5 的「每次载入从自动起步」。如果确实要持久化，那就是另一项产品决定，应当单独提出来。
- 如果协调者接受现状，至少要在 README 速查表里写明「手动档跨载入记忆，并决定地面精度」。

### L1（低）：README 和注释里有过时描述

- README「地面与数据」中「一次 texSubImage3D 传 16 MB…」这一条仍写着 `ground.attachGl(renderer.getContext())`，现在的写法是 `attachGl(renderer)`。
- `clipmap.ts` 构造函数里 `tex()` 的注释（「每次上传一层后 three 会对整个数组重新 generateMipmap」）已经不是默认路径，应改成「G07 起 Worker 按层生成，没接 GL 时才退回 three 整组生成」。

### L2（低）：GPU 探测的 powerPreference 与主渲染器不一致

`autoGroundRes` 里的 `getContext("webgl2")` 改成 `getContext("webgl2", { powerPreference: "high-performance" })`，免得双显卡 Mac 判低。可以顺带把规则微调一下：`quadro\s*[kpm]\d` 里的 P 系高端卡（P4000 / P5000 / P6000）可以放行；`radeon pro \d{3}x?`（Polaris 移动版）可以归 1024。都不急。

### L3（低）：探测抛异常时没有释放上下文

`try` 块里在拿到 `gl` 之后、`loseContext()` 之前如果抛异常，这个上下文不会释放。可以把 `loseContext` 挪进 `finally`。

### L4（低，记录）：PBO 路径在 ANGLE Metal 上没有实测

D3D11 上 commit 帧没有掉帧。Metal 后端从 PBO 拷贝可能走 CPU 映射，只能等用户在 Mac 上用 `G07-spikes.mjs` 看 `commitFrameIntervals`。如果那边出问题，退路是现成的：`stagedUpload = false`。

### L5（低，记录）：首载 8 s 内时间流速很大并跨过黄昏阈值

可能在灯光已经亮的时候做升级，出现一次灯光换版。实际几乎碰不到，可以不处理。

---

## 审查过程说明

- 本次测量期间，一个外部代理短暂持有测量锁：`g07rev-spikes5` 开跑时锁存在，跑完已释放。我当时没有等锁就开跑了，这是我的疏忽。好在数据是同页交替采集的，两种做法受到的干扰相同。其余测量都先执行了 `measure-lock.mjs wait`。
- 第一次跑 `G07-spikes.mjs` 时有 56 条 console error，都是 EOX 限流的 CORS 错误（与交接所述相同），不是 G07 引入的；`dev-browser check` 两档都没有 error。
- EOX 限流会影响跨版本对比，所以这次零回归一律用同页 A/B 判定；没有另做跨版本截图对比，实现者的 `G07-pair` 噪声底为 0，这里不重复。

## 开发体验反馈

- **最有用**：`stagedUpload` / `gpuMips` 这两个运行时开关，加上 `rebuildAll()`，让同页 A/B 几分钟就能搭起来，还能把「Worker mip」和「暂存」两个因素拆开测（四种组合）。建议以后涉及多个因素的性能任务都照这个做法，每个因素给一个开关。
- **缺的**：`workerStats` 只有累计量，没有每次任务的开始 / 结束时刻，我只能每 25 ms 轮询 count，再倒推忙碌区间。建议在 `imageryStats.worker` 里加一个环形缓冲 `recent: [{start, end, ms}]`，归因帧尖峰时直接可用。
- **坑**：`G07-recenter.mjs` 这类脚本不查测量锁，我一度忘了手动查。建议 `scripts/lib/chrome.mjs` 的 `launchBrowser` 在锁存在时默认打印一行醒目提示（和 `dev-browser` 一样）。
- **耗时**：读 diff 和核对着色器路径约 25 分钟；各项测量合计约 35 分钟，其中 1× 尖峰三轮就占了约 25 分钟。
