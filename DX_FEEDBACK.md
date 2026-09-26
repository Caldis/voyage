# 开发体验反馈汇总

协调者把各代理交付报告里的「开发体验反馈」原文摘录到这里，供开发体验官（和性能工程师）每波合并后处理。处理完的条目标注去向（DX-xx 任务 / 已改 SOP / 不采纳及理由）。

## 第 2 波

### T02（实现，Opus）
- 慢：冷编译每次 45–85 秒，累计十几分钟；等浏览器锁累计约 20 分钟；带地面场景等瓦片每个 6–40 秒；为测改前基线来回回退 / 重应用改动 3 次。
- 卡：回归脚本不输出 GPU 时间，而 rAF 帧时间被垂直同步锁在约 6.2 ms，没有参考价值；没有「冻结飞机位置」句柄，测闪烁困难；browser_run_code_unsafe 每次回显整份脚本源码，占上下文；共享浏览器 GPU 崩了会殃及所有代理，SOP 没写恢复方法（已补）；简报里「约 30 ms」的帧时间与这台机器（RTX 5090）不符。
- 绕过 / 希望：自己给脚本加了逐场景 GPU 计时（timer query）、用 Object.defineProperty 冻住 uCloudOffset 做静止两帧对比（`tmp/t02/full.js`）。希望回归脚本自带 GPU 计时与冻结选项；希望有 `--baseline` 模式自动在 5181 上跑同组场景对照；SOP 写明 WebGL 被禁用时 browser_close 重启（已补）。

### T14（实现，Opus）
- 慢：等浏览器锁合计约 40 分钟，最大耗时；15 秒 / 3 秒轮询都被别人抢先，改 1 秒轮询才拿到（锁是「抢占」而非「排队」）。
- 卡：Playwright MCP 只能读主仓库目录下的脚本文件，scratch 读不了；而 Write 又不允许从 worktree 写主仓库路径，只能先写 scratch 再 cp；worktree 里 heredoc + python 被判为「无法验证留在 worktree 内」而拒绝，需拆成先 Write 再执行；回归脚本只有 rAF 帧时间（被刷新率卡住）；A/B 对比要来回换文件、各冷编译一次。
- 希望：浏览器锁改排队（时间戳文件按先后）；`window.__voyage` 常驻 `renderer` 与带 readPixels 同步的 `bench()`；规定一个仓库内共享脚本目录（Write 和 MCP 都能访问）。

### T02 审查（Opus）
- 慢：真冷启动一次 50–95 s，10 分钟锁里一次冷启动测量就占 1.5 分钟；抢锁排队累计约 40 分钟。
- 卡 / 绕过：同端口着色器缓存让「冷启动」其实是热的——用 addInitScript 往着色器注入随机数强制不命中（`tmp/review-t02/cold.js`）；MCP 不能读 scratchpad 的脚本，只能放仓库 `tmp/`；镜头仍有漂移，连拍对比失真；npm 后台任务停了 vite 子进程还在，要按端口结束。
- 希望：回归脚本自带真冷启动测量、完全冻结镜头（位置 / 头部 / 爬升姿态）与 GPU 计时；GPU 计时时段独占（锁里加「GPU 独占」标记）；锁按先来后到。

### T03（实现，Opus）
- 慢：等锁合计约 1 小时（最长一次 > 30 分钟）；冷编译约 45 s；帧时间受其他代理占 GPU（99–100%）影响基本没法测。
- 卡：15 秒轮询总被每秒轮询者抢走；抢到锁时页面停在别人端口，脚本跑错服务器；共享浏览器被别人弄到 WebGL Disabled 要自己重开；浏览器重开前后窗口尺寸不同，改前改后无法逐像素对比。
- 希望：锁排队；回归脚本开头固定窗口尺寸、返回 origin 与 GPU 渲染器名；测帧时间时其他页面暂停渲染或用 GPU 计时查询；回归脚本自带「拉近雷暴」「固定闪光」选项（写法见其分支 `handoff/T03.playwright.js`）。

### T14 审查（Opus）
- 慢：等锁约 25 分钟，真正用浏览器约 4 分钟。
- 卡：头部空闲晃动且无冻结句柄，同场景两次截图构图不同（用 Object.defineProperty 冻结 head 与 uCloudOffset 绕过）；无帧计时句柄（包装 rAF 连跑 N 帧 + readPixels）；addInitScript 残留在共享页面，用完须 browser_close。
- 希望：`__voyage.freeze({head, offset, time})` 与 `bench(n)`；回归脚本内置「同会话两端口对比 + 分区亮度 / 帧差统计」；自动数 sampler 的检查脚本。审查脚本 `tmp/screenshot/review-t14/review.js`、`flick.js` 可复用。

### T06（实现，Opus）
- 慢：等锁约 50 分钟，用浏览器约 15 分钟；冷编译 70–90 s，失败要等超时才知道且会弄坏共享浏览器。
- 绕过：等锁时写代码；**离线着色器检查**：用 vite 在 node 里拼出完整片元着色器，再用 glslangValidator（npm 包 `glslang-validator-prebuilt-predownloaded`）检查语法 / 保留字，不占浏览器（脚本 `tmp-dump-shader.mjs` 在其 worktree，未提交）；改前对照用 `git archive` 拷 master + junction 指向 node_modules，在 5189 起服务。
- 希望：每个代理各起**私有 headless Chromium**（playwright-core 已在 npx 缓存）做编译检查与截图，锁只留给测帧时间；离线 glslang 检查写进 SOP、拿锁前必跑；固定的「基线端口」；关 vsync 或 GPU timer 的计时句柄。

### T03 审查（Opus）
- 卡：browser_navigate 首次打开常 30 s 超时（其实页面在编译，可忽略继续）；分支与 master 之间隔着 T14，直接比会混进海浪开销，只能临时合并 + 装依赖 + 另起端口（多约 3 分钟）；addInitScript 注入在页面里累积（冷编译注入残留会让之后每次都冷启动），测量之间必须 browser_close；外部 GPU 负载让同场景从 10 ms 跳到 120 ms。
- 希望：SOP 规定审查一律用「master 合并分支」构建对比（已补进 SOP 第 5 节）或给现成脚本；回归脚本自带多轮交替测量与离群剔除；`__voyageStartup` 按程序分别列出编译耗时（能直接看出是云程序还是场景程序变慢）。脚本在 `tmp/review-t03/`。

### T06 审查（Opus，兼美术总监）
- 慢：等锁 30 分钟以上。
- 卡：实现者用 rAF 中位数自测性能，被垂直同步掩盖——第二次同类误判（已写进 SOP 实现代理守则）；`git worktree add <path> master` 在 master 已检出时失败，要 `--detach`（已写进 SOP）。
- 希望：锁文件带过期时间 / 预计释放时间；批渲测法收进 `apps/voyage/scripts/`；审查脚本 `tmp/review-t06/`（shots / perf / cold / pair / crop）可复用。
