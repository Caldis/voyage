# G07b 独立审查

对象：分支 `worktree-agent-a340d51459cab77f5`（57f89d2），与 master b6c5051 合并后在临时 worktree `tmp/g07brev` 里复核（已删除），dev server 5226。硬件 RTX 5090 / ANGLE D3D11。
复核截图与放大图：`tmp/screenshot/G07b-review/`。

## 结论：**通过**（有 2 条低优先级建议，可以合并后顺手改，也可以记进看板）

五个重点都没有发现阻塞问题。解耦做得干净，探测的回退路径有一条小漏洞（下面 L1），不过在真实浏览器上几乎触发不到，就算触发，结果也和不修一样（都是 1024）。水体改 CPU 栅格后没有引入锯齿，已放大逐像素确认。mips 缓冲复用没有并发问题。和在途分支没有冲突。

## 复核结果

| 项 | 做法 | 结果 |
| --- | --- | --- |
| 类型检查 / 构建 | 合并后 `pnpm --filter voyage typecheck`、`build`（都先查了测量锁） | 通过；dist 里没有 0 字节文件 |
| GPU 规则自检 | `handoff/G07-gpu-rules.mts` | 59 条全部符合 |
| mip 缓冲复用 | `handoff/G07b-mipscratch.mts` | 逐字节差异 0 / 5 592 404；GC 26→10 次 |
| 面板端到端 | `handoff/G07b-panel.mjs 5226` | 16 项断言全过，控制台零 error |
| 探测回退 / 存储被禁 | 审查临时脚本：6 种注入场景，直接 import `/src/quality.ts` | 见下表 |
| 水体 CPU 与 GPU 栅格的语义 | 同一路径（外环、同向 / 反向内环、自交星形、0.7 px 细线海岸）分别在两种画布上画 2048² | nonzero 和 evenodd 下，洞的判定三处采样**完全一致**；两边都有抗锯齿（边缘半透明像素 GPU 13 896 个、CPU 13 105 个），差异只在覆盖率的量化上 |
| 夜景最大差放大 | 开发者自己的 `pair-water` 图，night-city 与 route-hnd-cts-night 找出 >8 的像素，按 10 倍最近邻放大 | 见下文第 3 条 |
| 冲突 | `git merge-tree`：G07b 分别对 master、C12b（7f8fd93）、T48c（400bcc6）、W-STAIR（40a86c4） | 全部没有冲突 |

探测与存储的注入场景（都没有 pageerror）：

| 场景 | 判定 |
| --- | --- |
| 正常 | 2048，自动：高性能独显，probeMs 10 |
| `OffscreenCanvas` 不存在 | 2048（退回 `<canvas>`，正确） |
| OffscreenCanvas 的 `getContext("webgl2")` 返回 null | 2048（退回 `<canvas>`，正确） |
| OffscreenCanvas 的 `getContext("webgl2")` **抛异常** | **1024，自动：GPU 探测失败**（没有退回 `<canvas>`，见 L1） |
| 读 `localStorage` 就抛 SecurityError | 2048，面板选项为 auto，`setGroundResPref` 不抛异常 |
| 旧键 `voyage.quality`、非法值 `voyage.groundRes=4096`、无关键 `voyage.audio.x` | 旧键被清掉，非法值当作 auto，无关键保留 |

## 按重点逐条

### 1. OffscreenCanvas 探测
- `powerPreference: "high-performance"` 和 `main.ts:35` 主渲染器一致。
- `loseContext()` 放在 `finally` 里，外面还包了一层 try，对 null 做了保护。
- 探测失败时判 1024，依据是「1024 至少不比 G06 之前差」，合理。
- **L1（低）**：OffscreenCanvas 和 `<canvas>` 两次尝试共用同一个 try。如果 `new OffscreenCanvas(1,1).getContext("webgl2")` 抛出异常，就会直接跳进 catch，`gl ??= <canvas>` 那一行根本不会执行，结果判成「GPU 探测失败 → 1024」，已经注入验证过。按 WebIDL，`OffscreenRenderingContextId` 是枚举，浏览器的枚举里如果没有 webgl2，就会抛 TypeError 而不是返回 null。现在主流的 Chrome、Firefox、Safari 17+ 都不会走到这里；Safari 16.4–16.x 的行为我没法实测，但就算抛了，Safari 的渲染器是「Apple GPU」，本来也判 1024，用户看到的结果不变，只是 reason 字符串写错了。修法：把 OffscreenCanvas 那次尝试单独包一层 try/catch，吞掉异常后再退回 `<canvas>`，改动只有 3 行。

### 2. 解耦
- grep 结果：`GROUND_RES` / `GROUND_RES_DECISION` 只在 `clipmap.ts:27` 取一次，其余引用都是着色器常量。`QualityController` 里已经没有 `storeTier`、`storedTier`、`groundResForTier`，`setTier` 和 `applyLevel` 也不碰地面精度。自动降档和地面精度**已经彻底无关**。
- 三处 localStorage 读写都包了 try/catch，另有 `?.` 兜底。清旧键时只 `removeItem("voyage.quality")`，不会误删别的键（上表已验证）。
- URL `?groundres=` 在 `decideGroundRes` 和 `nextGroundRes` 两处都排第一优先，面板端到端测试也覆盖了。
- 小瑕疵（不算问题）：本次载入是手动档、用户中途改回「自动」时，`describeGroundRes → autoGroundRes()` 会在运行时再开一个临时上下文（约 6–10 ms，只开一次，有缓存）。可以接受。

### 3. Worker 水体 CPU 栅格
- **语义**：画水体的 Canvas2D 调用序列一个字都没改，只换了后端（Skia GPU → Skia CPU）。填充规则、洞、坐标半像素约定是 API 层面的语义，两种后端一样，上面的合成测试也证实洞的判定一致。差异只在抗锯齿覆盖率上：CPU 用解析式覆盖率，GPU 用多重采样或覆盖率计数。两边**都做了抗锯齿**，CPU 这边没有退化成硬边。
- **夜景最大差放大看**（`tmp/screenshot/G07b-review/night-city-zoom.{a,b,diff}.png`）：night-city 有 74 个像素差超过 8（占 0.004%），最大 129。放大后看，这些全是**孤立的单个灯点**有或没有（在水陆边缘，水体遮罩覆盖率差一点，灯点过不过门限就翻转了），**看不到海岸线或道路出现阶梯、锯齿**。裁剪区域的相邻像素差均值 a 20.99、b 21.13，粗糙度没有变。route-hnd-cts-night 有 8 个像素超过 8，最大 32，性质相同。fuji-low-detail 最大差 2。
- **时间稳定性**：每一级的结果建一次就固定下来。重建换中心时，两种后端对同一路径的栅格化都是确定性的，不会逐帧抖动，因此不会引入闪烁，不违反铁律。
- **60× 积压**：Worker 每级要 250–750 ms，水体多出约 5 ms，也就是 0.7–2%。按 G06 记录的 60× 下 Worker 忙碌度约 95% 估算，大约升到 96–97%，影响在噪声量级。这一项我**没有实测**，只是按交接给的阶段耗时推算的。
- Safari 不认识 `willReadFrequently` 时会忽略这个选项，退回原来的 GPU 画布，不会报错。

### 4. mips 缓冲复用
- Worker 是单线程的，`onmessage → buildGroundLevel` 是同步调用，同一个 Worker 里的任务天然串行，不存在两个任务同时写同一块缓冲的情况。Worker 起不来时退回主线程，也是同步调用，一样安全。
- 看了 `albedoChain` 全文：`cur` / `next` 始终在 A、B 两块之间轮换，读和写不会落在同一块上；输出是另外 new 的 `Uint8Array out`，临时缓冲不外传，也不被转移。
- `mipScratch.reuse` 是模块级的可变开关，每个任务开始时同步设置，没有竞态。
- 代价：Worker 会常驻 16 + 4 MB（2048 档）。可以接受。

### 5. 冲突
G07b 分别和 master、C12b、T48c、W-STAIR 做 `merge-tree`，都没有冲突。README 与 W-STAIR 的 README 改动不在同一处。

## 问题清单（按严重度）

| 级别 | 编号 | 问题 | 修法 |
| --- | --- | --- | --- |
| 低 | L1 | OffscreenCanvas 的 `getContext("webgl2")` 抛异常时，不会退回 `<canvas>`，会误判为「GPU 探测失败」（已注入复现） | 把 OffscreenCanvas 那次尝试单独包 try/catch，再 `gl ??= <canvas>…`；自检里加一个「getContext 抛异常」的场景 |
| 低 | L2 | 型号规则有三处和它自己的理由不一致：`gtx\s*9[78]0` 没有 `\b`，所以 **GTX 970M / 980M**（移动版，970M 约等于桌面 960）也判成 2048，而桌面 960 是 1024；**Radeon Pro WX 3100**（Polaris 12，约等于 RX 550）判成 2048，而 RX 550 是 1024 | 正则改成 `gtx\s*9[78]0\b(?!m)`，或把 970M 单列为 1024；AMD 的排除项加上 `pro\s*wx\s*[23]\d{3}`；自检各补一条 |
| 信息 | I1 | 60× 下 Worker 多出约 5 ms，只做了推算，没有实测 | 下次跑 60× 积压测量时顺便看一下 `imageryStats.worker` 的忙碌度 |

没有中等及以上的问题。

## 开发体验反馈

- 交接写得很好：每个结论都附了命令和原始数据的路径，证据强度也标了（强 / 定位清楚 / 未复现）。「G07 比 G06 多」没复现，交接里如实写了出来，没有硬凑，这一点值得保留。
- `G07b-pair.mjs` 用环境变量换开关，同页 A/B 很方便。建议 `G07-diffs.mjs` 顺手输出「>8 像素的坐标，以及最大差附近的 10 倍放大裁剪图」。这次审查为了看锯齿，我另写了 Python 脚本来做这一步；按铁律，锯齿是最高优先级，这个功能值得收进工具。
- `measure-lock.mjs` 在临时 worktree 里也能正确找到主仓库的锁（`mainRepoRoot`），很好。
- 在只 import 一个模块、不启动整个 app 的前提下（`page.goto('/src/quality.ts')` 后 `import()`），用注入脚本测探测回退，一次只要几秒。以后要验证启动期的判定逻辑，可以用这个模式，不必每次都等整页载入。
