# VOY-DEFAULT · 连续航程默认开启 · 交接

分支 `worktree-agent-adb9b48d1fc94f8f3`。用户已拍板「可以打开」（research/TOWERING.md：默认不开天气场是普通航程看不到高耸云的首因）。

## 做了什么

| 文件 | 改动 |
| --- | --- |
| `src/ui.ts` | `initialVoyageOn()`：URL `?voyage=1/0`（也认 on/off、true/false，同名多个取最后一个）> localStorage `voyage.continuousJourney`（"0" 才关）> 默认开；`startVoyageByDefault(director)`；面板勾选框只在 `e.isTrusted`（真实点击）时写 localStorage，脚本 dispatchEvent 不写 |
| `src/director.ts` | `setActive(on, jump = false)`：jump 时 `weather.onJump()`（首帧直接对齐天气场）+ 机头对准第一段航线、坡度归零 |
| `src/main.ts` | **2 行**：import `startVoyageByDefault`；首次 `setPreset(state.preset.id)` 之后调用 `startVoyageByDefault(director)` |
| `scripts/dev-browser.mjs` | `openPage`（check / shots / ab / flight / gpu-ab / bench…）与 `cold` 的导航 URL 加 `voyage=0`；`cold` 新增 `--query` 透传（`--query "&voyage=1"` 测默认开启的真实首载） |
| `scripts/passes.mjs`、`probe.mjs`、`cpu-prof.mjs`、`regression.playwright.js`、`cabin-luminance.playwright.js` | 导航 URL 加 `voyage=0`（passes 的 `--param voyage=1` 可覆盖） |
| `README.md` | 「使用」加连续航程默认开启与 URL 参数；「调试与验证」applyScene 条补「工具一律带 voyage=0」；坑点「工具与环境」加一条 |
| `handoff/VOY-DEFAULT-check.mjs` | 验收脚本（默认开 / 1× / 天气场 / 手动关记住 / URL 强制 / 脚本切换不写存储 / 零 error / 首载对照） |
| `handoff/VOY-DEFAULT-ab-jobs.json` | 4 场景（default、noon-cumulus、sea-sc、fuji-day）A/A 的 ab jobs |

`scripts/scenarios.mjs` 的 `applyScene` 早已 `director.setActive(sc.continuousJourney === true)`（DX-12），没改。

## 为什么工具要带 voyage=0，而不只靠 applyScene 关掉

载入到 applyScene 之间导演已经：硬切云参数（`type`/`density` 不在面板上，但 cloud-preset change 会整套重设，这一项其实能恢复）、云影图分片状态、按天气场摆雷暴（带 id，`setActive(false)` 不撤）、写海面风、自动舱灯、改航向 / 目标高度 / 当前航段预设。其中大多数会被 DEFAULTS 覆盖，但逐项证明「全部撤回」不划算；带 `voyage=0` 页面从载入就与改动前同一状态，最稳。

## 验收结果（RTX 5090，d3d11 硬件渲染）

- `node apps/voyage/handoff/VOY-DEFAULT-check.mjs 5258 --base 5317`：全部通过——新页面默认开、1×、「对齐天气场：晴天积云」、接入 HND→KIX（当前位置起 653 km、巡航 10.7 km）、不写 localStorage；真实点击关掉 → 记 "0" → 刷新保持关；`?voyage=1` 强制开且不改记住的选择；脚本切换不写；重新打开 → "1" → 刷新保持开；`?voyage=0` 关；两种情况控制台零 error。
- 首载（热缓存，3 轮交替）：本分支 2520–2546 ms，master 2447–2592 ms，持平；「首帧渲染」约 216 ms vs 110–165 ms（首帧多一次天气场取样与硬切，加载遮罩还没撤，用户看不到）；首载后 8–10 s 帧间隔 >50 ms 的帧 0–1 个，最大 62 ms（master 50 ms），无编译卡顿。
- 真冷启动 `dev-browser cold --port 5258 --baseline 5317 --query "&voyage=1" --repeat 2`：totalMs Δ +0.5% / −2.2%，首帧渲染 560/569 vs 557/539 ms——不变差。
- 测量工具确定性：`dev-browser ab`（A/A，每场景 old,new,old#2,new#2）在 4 个场景（含 default）上，本分支默认（voyage=0）、本分支 `--query "&voyage=1"`（载入即开、applyScene 再关）、master 三次运行的**同页噪声底与 A/A 差全部 0 / 0**。跨运行（不同页面）的截图本来就不能逐像素比（云随 uTime 演化、翼尖弯曲相位，README 坑点），见下「跨运行对照」。
- typecheck、build（dist/assets 0 字节文件 0 个）、check:glsl 全部通过。

## 首屏观感（取舍，请协调者 / 美术总监看一眼）

- `tmp/screenshot/VOY-DEFAULT/default-5258.png`（本分支 10 s 后）vs `first-5317.png`（master）。
- 默认地点「西太平洋向南飞」前方没有机场，`airportAhead` 挑中西北方的关西（要转 140°）。第一版首屏是一个 25° 坡度右转、要转两三分钟——明显比现在差，已改为首载时机头直接对准航段（航向 320°）。
- 代价：master 首屏是右窗朝西、夕阳在窗里（8° 高度的逆光），现在右窗朝东北、太阳在身后，画面是顺光的积云与海，平静但不如逆光戏剧化。要找回逆光：要么航线网加一个南方机场（关岛 / 塞班，`routes.ts`，不在本任务归属），要么换默认地点 / 默认时刻。没动，留给协调者决定。
- 舱灯：导演按太阳自动（白天开、太阳 < −3° 转睡眠档），首屏与原默认一致（开）；流速 1×。默认时刻仍是「当天太阳降到 8° 的时刻」（约 16:50），1× 下大约 40 分钟后入夜，舱灯会自动调暗。

## 跨运行对照（参考）

各次 ab 第 1 轮参照图 `a.png` 两两相减（整图，0–255；mean / max / 差 > 8 像素数）：

| 场景 | 本分支 vs master | 本分支（载入即开）vs master | **master vs master（再跑一次）** |
| --- | --- | --- | --- |
| default | 3.95 / 181 / 188k | 7.16 / 186 / 256k | 6.65 / 176 / 237k |
| noon-cumulus | 2.95 / 224 / 145k | 1.09 / 223 / 62k | 1.37 / 205 / 47k |
| sea-sc | 0.35 / 78 / 11k | 0.72 / 83 / 42k | 0.26 / 75 / 7k |
| fuji-day | 0.70 / 60 / 23k | 0.31 / 61 / 15k | 0.38 / 44 / 4k |

master 自己两次运行的差与本分支对 master 的差同一量级——跨运行本来就不确定（云随 uTime 演化、翼尖弯曲相位），判零回归要用同页 A/A（上面全部 0）。

## 已知问题 / 未做

- 面板「地点」下拉仍显示「西太平洋上空 · 向南飞」，而实际已是航段「当前位置 → 关西」（改动前手动开连续航程也是如此）。
- `?voyage=0` 与 `--query` 同时给时靠「最后一个为准」；手写脚本请直接带 `?voyage=0`。
- MCP 共享浏览器里手动打开页面（不经回归脚本）会进连续航程；只要不点勾选框，不会改用户记住的选择。

## 复现

```
pnpm --filter voyage exec vite --port 5258 --strictPort --host 127.0.0.1     # 5257 被 C-FLAT 审查占用，本任务改用 5258
node apps/voyage/handoff/VOY-DEFAULT-check.mjs 5258 --base 5317
node apps/voyage/scripts/dev-browser.mjs ab --port 5258 --jobs apps/voyage/handoff/VOY-DEFAULT-ab-jobs.json --out tmp/screenshot/VOY-DEFAULT/ab-off
node apps/voyage/scripts/dev-browser.mjs cold --port 5258 --baseline 5317 --query "&voyage=1" --repeat 2
```
