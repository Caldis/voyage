# UX-2 · 连续航程接管时面板显示实际值 · 交接

分支：`worktree-agent-a9e9be8f8c64a895b`（合并点 master `dbbfc35`；merge 之后 master 又前进到 `744f870`——本波并行的 PERF-STORM 等任务，详见下面「关于对照基准」）。
状态：完成，待审查。规范依据：`research/PANEL_UX_GUIDE.md` §5.3、`research/PANEL_UX_AUDIT_1.md` 的 P1 / P9 / UX-2 条目。

## 问题（审计原话）

VOY-DEFAULT 合并、连续航程默认开启后，普通用户打开页面看到的面板值是错的：云量滑条显示 42%（实际 `uCoverage` 34%）、海面风速显示 7 m/s（实际 `state.wind` 1.0）、「地点」下拉停在起飞前选的预设（实际航段已经是「羽田 → 关西」）。根因：这些控件只在用户 `input` / `change` 事件里才写显示，导演 / 天气场改状态时没有任何代码把新值回写面板（`ui.ts` 的 `bindRange` 只挂了 `input`）。另外脚本旁路改状态（`director.setActive(false)`、`wonders.enabled = false`，不经过面板、不 `dispatchEvent`）后，`voyage-on` / `wonders-on` 复选框也停在旧值（P9）。

## 语义决定：为什么云量 / 云底 / 云厚 / 海面风速是 nudge，天气系统 / 云型是 lock，地点不设限

`PANEL_UX_GUIDE.md` §5.3 规则三给了三选一（`lock` / `nudge` / `pause`），本任务里按控件的实际可行性挑：

| 控件 | 语义 | 理由 |
| --- | --- | --- |
| 云量、云底高度、云层厚度、海面风速 | **nudge** | `weather-director.ts` 本来就实现了这个行为：`stepParams()` 每帧检查 `cloudParams()` 是否等于上一次推给云的值（`sameParams`），不等就说明被外部（面板拖动、脚本）改过，直接把 `cur` 重置成新值再继续 `approach()` 逼近目标；`stepSeaWind()` 同理检查 `st.wind !== this.seaWind`。也就是说**系统侧的「推一下，从新值接着走」早就有了**（WX11g、T19b 就是这么设计的），本任务只是把这件事如实显示出来，没有新增任何控制逻辑。选 nudge 是顺着已有实现走，不是新发明一套规则。 |
| 天气系统（`#weather`）、云型（`#cloud-preset`） | **lock** | 换云族（积云 ↔ 层积云 ↔ 卷云……）是「跳变项」，要么等遮挡硬切、要么在云量淡到 0 时切（`planRegime` / `switchRegime`），不是每帧连续量，没有「拖一下从新值接着走」这回事——用户选了别的云型，下一次天气场规划大概率会把它当成「面板预设留下的（没有 id）」重新接管，体验上等于白选。天气系统更极端：天气场此刻可能同时摆着好几个雷暴 / 台风（`weather.storms` 是数组），`WEATHER_PRESETS` 只有 6 个单选项，没有单一预设能代表「孤立雷暴 2 个 + 台风 1 个」这种组合态，连「显示实际值」都做不到，只能锁定 + 用 `title` 给一句人话摘要（复用已有的 `director.weather.describe()`，没有新写摘要逻辑）。 |
| 地点（`#preset`） | **不锁定，只如实显示** | 手动换地点在连续航程开着时本来就是被支持的显式操作——`director.onPresetChanged()` 早就处理了「用户跳变」这条路径（换本地坐标原点、天气对齐天气场、清掉排队中的掉头）。这不是「接管冲突」，是导演一直允许的用户指令，锁掉反而是新增限制、没有正当理由。「自动」标记只在 `director.active` 时显示，提示「这个位置目前在自动往前推进」，不代表「不能改」。 |

`PANEL_UX_GUIDE.md` §5.3 规则一（显示实际值）对**所有**被接管的控件都成立，包括锁定的两个下拉：`cloud-preset` 的选项 id 与 `CloudRegime`（`clear` / `cumulus` / `towering` / `stratocumulus` / `altocumulus` / `cirrus`）完全同名，所以锁定的同时也把 `.value` 同步成 `director.weather.regime`，不展开下拉也能看出当前云型；`weather` 下拉因为上一段的原因做不到，退而求其次把实时摘要放进 `title`。

**「已手动调整」标记何时清空**：观察 `director.leg` 每次接力（`beginLeg`）都会创建一个新对象（`relay()` → `beginLeg(next)`，`onPresetChanged()` → `joinNetwork()` → `beginLeg`），拿它的对象引用变化当「换航段」的信号，比对比 `state.preset.id` 字符串更可靠（同一条航线两次经过时 id 会重复，引用不会）。换航段、或连续航程被关掉时，四个 nudge 控件的「已手动调整」标记清空，回到普通的「自动」。

## 做了什么

只改了归属内的三个文件，**没有改 `director.ts` / `weather-director.ts`**——简报里说「如需暴露只读 getter，最少改动并写清」，但核对后发现 `Director.active`、`Director.leg`（`readonly`）、`Director.weather`（`readonly WeatherDirector`）、`WeatherDirector.enabled` / `.regime` / `.describe()`、`state.wind`、`cloudUniforms.uCoverage/uCloudBottom/uCloudTop` 全部已经是公开字段，`setupUi` 的 `UiDeps` 也已经把 `director`、`cloudUniforms`、`state` 传给了 `ui.ts`，不需要新增任何读接口。

| 文件 | 改动 |
| --- | --- |
| `src/ui.ts` | 新增 `setupWeatherAutoSync(deps)`（约 100 行，插在 `setupNavUi` 之后）：250 ms 轮询，`owned = director.active && director.weather.enabled` 时回写云量 / 云底 / 云厚 / 海面风速的 `value` 与 output 文字（拖动中 `input`→`change` 之间的控件不抢，用独立的 `dragging` 标记，做法与已有的 `hdg` 滑条一致，不用 `document.activeElement`——range 松手后焦点还在控件上，用 activeElement 判断会导致松手后永远同步不回来）；用户 `isTrusted` 的 `input` 标「已手动调整」，`director.leg` 换了新对象或连续航程关掉时清空；`weather` / `cloud-preset` 下拉 `disabled = owned`，`title` 写原因（前者带 `director.weather.describe()` 摘要，后者带 `REGIME_NAMES[regime]`），`cloud-preset.value` 同步成 `director.weather.regime`；`syncPresetOption()` 在 `state.preset.id` 以 `leg-` 开头时插入 / 更新一个 `<option>` 显示 `state.preset.name`（沿用 `director.beginLeg` 已经写好的名字，没有新造文案）并选中，`preset-auto` 只在 `director.active` 时显示。`setupVoyageUi`、`setupWonderUi` 各加一行 `window.setInterval(sync, 250)`（原来的 `sync()` 只在用户点击等事件里调用，脚本旁路改状态后追不上，P9）。`import` 加了 `REGIME_NAMES`（`./weather` 已导出的常量，没有新建）。 |
| `index.html` | 7 个控件（`preset`、`weather`、`cloud-preset`、`coverage`、`cloud-base`、`cloud-thick`、`wind`）各加一个 `<span id="xxx-auto" class="auto-badge" hidden>自动</span>`，插在标签文字与控件之间。**控件本身的 id / value 一个字没改**，只加了新的 `<span>`。 |
| `src/style.css` | 加 4 行：`.auto-badge { color: var(--accent); font-size: 11px; font-weight: 600; }`。显示 / 隐藏靠已有的全局 `[hidden] { display: none !important; }`（UX-1a），没有新写选择器。 |

截图：`tmp/screenshot/UX-2/ux2-auto-badges.png`（默认页面，天气区展开，可见天气 / 云 / 云量 / 云底高度 / 云层厚度 / 海面风速六项都标着金色「自动」，天气 / 云两个下拉变灰禁用）。

## 验收结果

- **typecheck / build / check:glsl**：全部通过；`dist/assets` 0 字节文件数为 0。
- **`voyage=1` 默认页面，1 分钟内逐项核对**（`node handoff/UX-2-check.mjs <端口>`，真实 GPU d3d11）：t=0/10/20/30/40/50/60s 七次抽样，云量 / 云底 / 云厚 / 海面风速 / 云型 / 地点六项显示值与 `__voyage` 读回的实际值全部一致；天气系统 / 云型下拉在接管时确认 `disabled=true` 且 `title` 含解锁办法；七次抽样的「自动」标记状态与接管状态（`owned`）逐次一致。
- **nudge 语义**：键盘方向键真实改风速滑条（Playwright 合成的键盘事件是 OS 级别的 trusted 事件）后，显示值立刻等于新的 `state.wind`（没有被 250 ms 同步覆盖回旧值），标记变成「自动（已手动调整）」，云量 / 云底 / 云厚没有被连带误标。点「立即触发到达」换航段后，标记恢复「自动」，同时六项显示值继续与新航段的实际值一致。
- **lock 语义 + 关闭后解锁**：关掉连续航程后 `weather` / `cloud-preset` 的 `disabled` 变回 `false`，全部「自动」标记隐藏。
- **P9 回归**：`page.evaluate` 里直接 `director.setActive(true)` / `wonders.enabled = true`（不 dispatch 任何事件，模拟 `applyScene` 的写法），300 ms 内 `voyage-on` / `wonders-on` 复选框跟上。
- **控制台零 error**：验收脚本全程（含地面瓦片跨域噪音已过滤）与前面所有截图 / check 运行都是 0 条。
- **打字 / 快捷键守卫不受影响**：本任务没有改 `isTypingTarget` / `isLetterShortcut` 或任何 `keydown` 监听（`git diff` 可核对 `ui.ts` 里这两个函数所在的代码块完全没动）；另外活体验证：焦点在 `#date`（文字类）时按 `H` 不隐藏面板，焦点在 `#wind`（range，非文字类）时按 `H` 正常隐藏，与改动前行为一致。
- **`voyage=0` 与回归场景行为不变**：见下面「关于对照基准」，用 7 个代表场景（`noon-cumulus`、`sea-sc`、`storm-sc`、`fuji-day`、`route-hnd-cts`、`night-city-on`、`economy-ahead`，覆盖云 / 天气 / 地面 / 舱等 / 航段几类状态）核对，`dev-browser.mjs shots` 输出的 `panel` 字段（每场景 16 项面板控件值）逐项与 master 完全一致，零差异。这个结论也能从代码直接看出来：`setupWeatherAutoSync` 里所有会改变显示 / 行为的分支都套在 `if (owned)` 或 `if (isLeg)` 里，`voyage=0` 默认场景 `director.active` 恒为 `false`、`state.preset.id` 都不以 `leg-` 开头，这些分支全部走不到；两个新增的 `setInterval(sync, 250)` 调的是已有的 `sync()`，只是把当前已经正确的值又设了一遍（幂等），不产生任何新副作用。

### 关于对照基准

第一次直接拿本分支截图和「当前 master」比，`noon-cumulus` 场景 mean 差到 6.74（10.4% 像素超阈值），一度以为是回归。按 `DEV_SOP.md` 第 5 节的提醒排查：本分支的合并点是 master `dbbfc35`，但 master 在等待审查期间又前进到了 `744f870`（并行的 PERF-STORM 等任务合并进去了），直接对比会把别人的改动也算进来。做了 master 自比（同一份 `744f870` 代码跑两次）验证噪声底：`noon-cumulus` 两次 master 之间 mean 差 2.44（6.1% 超阈值），`sea-sc` 1.86（7.8%）——和本分支 vs master 的差同一量级，说明这些差异是地面瓦片网络加载时序 + 云的时间累积这类跨运行本就有的噪声（README 坑点「零回归判断的基准是『同一份代码跑两次』的噪声底，不是 0」），不是回归。更可靠的判据是 `panel` 字段（不受渲染噪声影响）：7 个场景、16 个控件值逐项比较，零差异。

## 复现

```bash
# 起本任务的开发服务器（voyage=1 默认页面在 http://127.0.0.1:5276/）
pnpm --filter voyage exec vite --port 5276 --strictPort --host 127.0.0.1

# 1 分钟多次抽样 + nudge/lock 语义 + P9 回归验收（真实 GPU d3d11）
node apps/voyage/handoff/UX-2-check.mjs 5276

# voyage=0 回归场景面板值比对（需要一个 master 对照 worktree，见 DEV_SOP §5 第 0 条）
node apps/voyage/scripts/dev-browser.mjs shots --port 5276 --angle d3d11 --only noon-cumulus,sea-sc,storm-sc,fuji-day,route-hnd-cts,night-city-on,economy-ahead --out tmp/ux2-regress/new
node apps/voyage/scripts/dev-browser.mjs shots --port <master对照端口> --angle d3d11 --only noon-cumulus,sea-sc,storm-sc,fuji-day,route-hnd-cts,night-city-on,economy-ahead --out tmp/ux2-regress/base
# 然后逐场景比较两边 .json 的 panel 字段（本任务写过一次性脚本，没有留在仓库里，逻辑很简单：两边 panel 对象逐 key 比较）
```

## 已知问题 / 未做（不在本任务范围内，留给后续任务）

- `cloud-base` / `cloud-thick` 每次 `input` 都调 `clouds.snap()`，拖动中云反复重置（`PANEL_UX_AUDIT_1.md` 控件清单里备注过，属于 §4.2「昂贵副作用放到 `change`」，本任务没有触碰这两个滑条已有的 `bindRange` 绑定，只加了新的只读同步，行为不变，一并留给后续任务）。
- 标签文案的术语统一（「云」→「云型」、「天气」→「天气系统」）留给 UX-3（按 `PANEL_UX_AUDIT_1.md` 建议顺序，UX-3 做分区折叠时一并按术语表改名，避免两个任务都碰同一批标签文字引发冲突）。
- 「天气系统」下拉目前**不会**在接管时显示成任何单一预设值（设计决定，见上面「语义决定」），如果以后想让它也显示点什么，需要先扩展 `WEATHER_PRESETS` 或另设一种「组合态」的展示方式，不在本任务范围。
- 手动改风速后，「已手动调整」的效果是「系统从新值继续、慢慢拉回天气场目标」（`weather-director.ts` 原有行为），不是「维持用户值直到航段结束」——如果某次取样天气场目标恰好等于用户刚设的值，会立刻显示回「自动」而不是等到换航段。这与 `nudge` 语义定义一致（「拖完系统从新值接着走」），不算 bug，写在这里避免以后被误判成「标记消失得太快」。
