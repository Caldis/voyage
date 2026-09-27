# PERF-5 交接：画质「自动」档（已完成，待审查）

分支 `worktree-agent-ad89bf8cd7f15897e`，开发端口 5245。依据 `research/PERF_REPORT_wave3.md` §2.3（PERF-5）。

## 已完成

- 新建 `src/quality.ts`：画质档位与自适应逻辑的唯一出处。
  - 面板从「高 / 中 / 低」（数值 1 / 0.75 / 0.5）改成「自动（默认，推荐）/ 高 / 中 / 低」（`index.html` `#quality`）。手动三档行为与改动前**完全一致**：只缩放云步进分辨率（`clouds.resolutionScale`），DPR 上限固定 1.5。
  - 自动档额外多一档「最低」（云步进 0.5 分辨率 + `setPixelRatio` 上限降到 1.0，对应报告里「低档把 DPR 上限降到 1.0」的建议），手动选不到，只有自动档在前三档都压不住时才会伸到这里。
  - GPU 计时：`GpuTimer` 类封装 `EXT_disjoint_timer_query_webgl2`，一帧一个 query、8 个一池轮流用，非阻塞轮询（`poll()`），`GPU_DISJOINT_EXT` 为真时整批结果作废。没有这个扩展时 `available=false`，所有方法空操作，调用方不用关心。
  - 判档：有 GPU 计时时预算固定 `(1000/60)×0.7 ≈ 11.7 ms`（**不**按侦测到的刷新率换算，见下面「踩的坑」）；降档快而严格（连续 700 ms 过载才降，中途掉回预算内就整个重算），升档慢而宽容（滞回到 55% 预算以下、且中间只要没有真正过载就持续计时，见「踩的坑」）；两次调档之间至少间隔 1.5 s。没有 GPU 计时扩展时退化成挂钟帧间隔的反应式判断（帧间隔明显超过一次刷新周期才判定过载）+ 探测式升档（定期乐观地试着升一档，3 s 内没再掉帧就保留，掉了就退回并把下次尝试的间隔翻倍，上限 60 s）。
  - `hintHeavyScene()`：天气切到雷暴 / 飑线 / 台风（`isHeavyWeather`，对应 `weather.ts` 的 `storm/squall/typhoon-*`）时，若还在最高档就先发制人退到「中」，不用等 700 ms 的持续过载判断才反应。
  - `describe()`：面板「画质」下面那行状态文字（`#quality-status`），手动档标「（固定）」，自动档带上依据的数字，例如「自动 → 中（GPU 6.4 / 预算 11.7 ms）」或「自动 → 低（无 GPU 计时，帧间隔 24.1 ms）」。
- `src/ui.ts`：`UiDeps` 加 `quality: QualityController`；`#quality` 的 change 事件改调 `quality.setTier(...)`；`applyWeather()` 里调 `quality.hintHeavyScene(...)`；不再需要的 `resize` 依赖从 `UiDeps` 里删掉（画质切换的 resize 现在由 `quality.ts` 内部处理）。
- `src/main.ts`：
  - 初始 `renderer.setPixelRatio` 改用 `quality.ts` 导出的 `DEFAULT_DPR_CAP`（单一出处，等于 `LEVELS[0].dprCap`）。
  - `resize()` 定义好之后创建 `const quality = createQualityController({ renderer, clouds, resize })`；构造时不重新应用一次分辨率 / DPR（起点已经和上面的初始设置对齐）。
  - **GPU 计时只包在真实 rAF 循环的 `frame(now)` 里**（`quality.beginFrame()` / `quality.endFrame()`），**没有**放进 `renderFrame()` 本体——`benchFrame()` 直接调用 `renderFrame`（不经过 rAF），如果把计时塞进 `renderFrame`，自动档会在其他任务用 `dev-browser bench` 做性能回归时中途改分辨率，把基准污染掉。这是本任务里最重要的一处工程决定，写了详细注释。
  - 面板状态行按 `cabinClassUi` 的写法做了 diff-then-write（`qualityUi` 变量），不是每帧硬写 DOM。
  - `window.__voyage` 调试句柄加了 `quality`。
- `clouds.ts` **完全没改**：画质切换沿用 `clouds.setSize()` 已有的逻辑——它本来就会在分辨率变化时把 `reset` 标记为 `true`（`src/clouds/clouds.ts:906` 附近），历史缓冲跟着重建，不会因为档位跳变出现云的时间累积错位或重影。验收时也确认了：连续切换分辨率没有看到云边缘的跳变/闪烁（见下面截图与测试记录）。

## 踩的坑

1. **一开始用「挂钟帧间隔的滑动最小值」估显示器刷新周期，再拿它算预算（60fps×70% 换成「侦测刷新率×70%」）——这是错的，已经改掉。**
   现象：私有 headless 浏览器（`dev-browser.mjs` 的机制，`--use-angle=d3d11`，真实 GPU）不像真显示器那样有硬 vsync 节流，rAF 能跑多快就跑多快；我最初的「滑动最小值」估计器直接收敛到「GPU 完全空闲时能跑多快」本身（实测约 6 ms，换成 150+ fps），算出来的预算不到 11.7 ms 的一半，导致**完全不重的场景**（noon-cumulus，实测 GPU 4–5 ms）都被判定「过载」，画质一路砸到「最低」再也升不回来。
   根因：GPU 计时本身已经是与显示器无关的绝对硬件耗时（`EXT_disjoint_timer_query_webgl2` 测的是 GPU 执行时间，不是挂钟时间），完全不需要再靠一个「挂钟帧间隔」去反推预算——这个信号在没有真 vsync 节流的环境里根本不可靠。
   修法：有 GPU 计时时预算直接写死 `(1000/60)×0.7 ≈ 11.7 ms`，不再依赖任何挂钟信号；`vsyncEstimate` 只留给「没有 GPU 计时扩展」的兜底路径用（那条路径本来就只能靠挂钟信号反应式抓掉帧，跟真 vsync 的存在与否强相关，这是它的固有局限，不是新引入的问题）。
   以后怎么识别：如果自动档在明显不重的场景下也长期停在低档，先看面板状态行的「预算」数字是否明显小于约 11.7 ms——是的话说明分母又被什么信号带偏了。
2. **升档的滞回判断一开始「只要有一帧回到中间地带就整个清零重来」，导致卡在中间档位出不来。**
   现象：typhoon-bands 降到「中」之后，实测耗时稳定在预算的 45%–70% 之间（有真实地面瓦片加载、云影图/占据网格分帧重建这类正常噪声），从没真正过载（没超过 100% 预算），但也从没能**连续** 3 秒都严格低于「55% 预算」的升档阈值——每次快攒够 3 秒，一帧稍高的读数就把计时器清零重来，于是永远升不回「高」。
   修法：把 `underSince`（升档计时起点）的清零条件从「pressure 超过 UPGRADE_RATIO」收紧成「pressure 超过 DOWNGRADE_RATIO（真的过载）」——中间地带（55%–100% 预算之间）不算过载也不算「已经宽松」，计时器保持原样、既不重置也不新开一段。降档这一侧**没有**做同样的放宽（降档要快、要严格，中途哪怕一帧回到预算内也整个重新计时），这是有意的不对称：错误地多等一会儿再降档，代价是可见的掉帧；错误地早一点升档，代价是被更严格的降档立刻纠正回来（700 ms 内）——两边风险不对等，所以宽容只给升档。
   以后怎么识别：自动档降下去之后长期不回升，且面板状态行显示的 GPU 数字明显低于预算（不是卡在临界值附近），基本就是这个「计时器被噪声打断」的模式。
3. （不算坑，记一下）`clouds.setSize()` 本来就会在分辨率变化时把 `reset` 置 true（见 `src/clouds/clouds.ts` 的 `setSize()`），历史缓冲跟着重建——这正好是任务要求的「切换分辨率时云的时间累积要正确重置」，不需要在 `quality.ts` 或 `main.ts` 里再单独处理，沿用现成的 `resize()` 调用链就行。

## 数字（RTX 5090，d3d11，真实 rAF 循环，`handoff/PERF-5-check.mjs`）

| 场景 / 视口 | 现象 |
| --- | --- |
| noon-cumulus，1600×1200 DPR1（本机原生） | 稳定「高」，GPU 4.2–5.9 ms（预算 11.7 ms），从未触发降档 |
| typhoon-bands，1600×1200 DPR1（本机原生） | 先降到「中」（GPU 4.9–7.7 ms），约 3.5 s 后回升到「高」并稳定（GPU 5.7–6.3 ms）——PERF-2 之后原生分辨率确实已经不需要长期降档，只是天气切换瞬间的过渡有一下短暂降档，符合预期 |
| typhoon-bands，1600×1200 窗口 × DPR1.5（实际绘制 2400×1800，模拟高分屏 / 弱 GPU） | 降到「中」并稳定数秒（GPU 5.3–8.1 ms），随后一度回升到「高」在预算边缘徘徊（GPU 10.9–11.6 ms，贴着 11.7 的预算线） |
| 上一项基础上把视口收窄到 800×600（同 DPR1.5，画布约 1200×900，比原生视口还小） | 回升到「高」并稳定（GPU 5.7–7.3 ms） |
| 再放大回 1600×1200（画布回到 2400×1800） | GPU 一路升到 10.6–18.8 ms，约 1–1.5 s 内（几次采样）判定过载并降回「中」 |
| 手动选「低」+ typhoon-bands 2 s | `tier` 保持 `"low"`，`resolutionScale` 保持 0.5，不受自动逻辑影响（验证手动档与自动档互不干扰） |
| 快速反复切场景 + resize 6 轮（`PERF-5-console-check.mjs`） | 控制台 0 error / pageerror，GPU query 池没有耗尽报错，`resize` 路径没有异常；最终稳定落在某一档（不是每次都回到「高」，因为升档故意做得慢，避免抖动） |

结论：大视口 + typhoon-bands 下能降到预算内，画质不再掉出目标帧预算；场景变轻或视口变小之后能可靠回升，不会永久卡死在低档；普通场景在原生分辨率保持最高档；手动档位完全不受自动逻辑干扰；快速切换场景 / 视口没有观察到抖动式的来回跳档（升档故意做得保守，短时间内的剧烈变化会先停在较低档，之后有几秒空闲才会往上探）。

## 截图

`tmp/screenshot/PERF-5/panel-default.png`（整个面板 + 窗外画面，确认没有视觉回归）、`panel-quality-zoom.png`（画质下拉 + 状态行特写，确认新增的 `#quality-status` 渲染正常，文字是「自动 → 高（GPU 1.3 / 预算 11.7 ms）」这类格式）。

## 需要协调者接入的代码

无。改动全部在归属文件内（`src/main.ts`、`src/ui.ts`、`index.html`、新建 `src/quality.ts`），没有碰 `clouds.ts` / `scene.ts` / `outside-pass.ts` / `cabin*` / `wing*` / `exposure.ts`。

## 已知问题 / 留给下一波

- 升档做得比较保守（3 秒连续不过载才升一档，且只在「有 GPU 计时」的机器上才有这种正向的连续判断），代价是切到轻场景后有几秒钟画质暂时低于其实能承受的档位；这是有意的取舍（宁可保守，不来回跳），如果用户反馈「切到轻场景后画质回升太慢」，可以把 `UPGRADE_HOLD_MS`（quality.ts）调短。
- 没有 GPU 计时扩展的机器（例如某些版本的 Safari）走的是「帧间隔反应式判断 + 探测式升档」这条路径，本任务没有实机验证（本机 ANGLE d3d11 一直有这个扩展）；报告里也提到 macOS 没有实测数据。这条路径的正确性目前只靠代码审查 + 无 GPU 计时场景的手动 review 保证，建议下一次有 Mac / Safari 环境时补一次实测（尤其是 Safari 的 WebGL2 timer query 支持情况）。
- 高刷新率显示器（120 Hz / 144 Hz）上，GPU 计时路径的预算固定按 60 fps × 70% 算（≈11.7 ms），不会因为显示器刷新率更高而收紧——这是「踩的坑 1」修完之后的直接结果（有意放弃了动态侦测刷新率，因为那条路径在无 vsync 环境下会失灵）。实际影响：高刷新率屏幕上自动档会比理论最优稍微「贵」一点，但不会像之前那样直接失灵瘫在最低档。如果以后要支持，需要一个比「挂钟帧间隔滑动最小值」更可靠的刷新率探测手段（例如 `screen.refreshRate`，目前还是实验性 API）。
- `renderer.setPixelRatio` 目前只在画质档位变化时重新应用；窗口被拖到不同 DPI 的显示器之间不会自动重新评估 DPR 上限——这是改动前就有的既有行为（原来的初始化也只设一次 pixelRatio），不是本次引入的新问题，没有在本任务范围内处理。
- `handoff/PERF-5-check.mjs`、`PERF-5-console-check.mjs`、`PERF-5-shot.mjs` 是验收用的临时脚本，保留在 `handoff/` 供审查参考（同 W01 / T32 等任务的惯例），交付后可以删。

## 怎么复现

```bash
cd apps/voyage && npx vite --port 5245 --strictPort --host 127.0.0.1
pnpm --filter voyage typecheck && pnpm --filter voyage build && pnpm --filter voyage check:glsl
node apps/voyage/handoff/PERF-5-check.mjs --port 5245          # 大视口降档 / 恢复的完整记录
node apps/voyage/handoff/PERF-5-console-check.mjs --port 5245  # 快速切场景 + resize 压力测试，看控制台报错
node apps/voyage/handoff/PERF-5-shot.mjs --port 5245           # 面板截图
```
浏览器控制台调试：`window.__voyage.quality.describe()`、`.level`、`.tier`、`.gpuTimingAvailable`；`window.__voyage.quality.setTier("low")` 手动切档。
