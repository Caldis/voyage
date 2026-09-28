# G-FREEZE · 冻结后地面仍在变 · 交接

分支 `worktree-agent-a1ddf063261f16a46`（已合并 master cd6a545，含 DX-26），开发端口 5243，对照 5303（`tmp/G-FREEZE-base`，master 分离检出，交付前删除）。

## 结论

**根因：等待判据太松，不是冻结漏了状态。** `ground.pending` 只数瓦片请求；瓦片取齐之后还有拼接 Worker → 合成 Worker（2048² 每级 0.3–0.7 s，串行）→ 暂存上传，7 级排完要几秒。applyScene 最后一步才摆 `offset`（飞机从原点跳到 [0, −25]），pinGeometry 又把飘走的飞机拉回，冻结时各级正在按新机位重建。ab 原来「冻结 → 等 pending === 0 → 再等 2 s」，截图期间各级陆续换上 → 同设置两张地面不同。

night-city-low 与 night-city-off **同因**：差异量级不同只是因为 1 km 低空时最后换上的 L0 / L1 占满视野（T48c 20 万像素），4 km 时换上的级别在画面里占得少（W-LAMP 1.7 万–15 万）。

排除掉的怀疑：冻结期间 clipmap 按固定机位不会换级 / 先粗后细（夜里直接 fine）；没有 LRU 换出后重建（稳定后 30 s 无任何构建事件）；夜光没有随机相位（稳定后 30 s 逐秒整窗哈希不变）。

### 诊断证据（`handoff/G-FREEZE-diag.mjs 5243 night-city-low,night-city-off 30`，输出 `tmp/screenshot/G-FREEZE/diag/`）

按 ab 旧流程（applyScene settle → pin → 90 帧 → 冻结 → pending 0 → 2 s）后逐秒截图 + 记各级状态 / 换版事件：

- night-city-off：起点时 L0–L2 仍 building、合成 Worker 3 个任务在途；t+0 s 换版计数 26→28、t+1 s 再 +1，**整窗哈希在 t+1 s 变了**；之后 t+1…t+30 s 哈希不变。事件：冻结前 0.26 s L0 才开始按 [0, −25] 重建，冻结后 0.39 / 0.92 / 1.44 / 2.12 / 2.65 / 3.08 s 依次换上 L5…L0。
- night-city-low：这一次瓦片取得慢（pending 归零晚），L1 在冻结后 3.86 s 换上，恰好早于观察起点，所以 30 s 哈希都不变——同一个竞态，赢输看瓦片快慢，这就是「来回变」、时有时无的原因。

## 改了什么

| 项 | 做法 | 文件 |
| --- | --- | --- |
| 稳定判据 | `ground.unsettled()`（返回原因或 null）/ `ground.settled`：pending 0、上传队列空、拼接 / 合成 Worker 无在途、minLevel 起每级 valid 不在建，且按上一次 update 的机位 update 不会再重建（中心 / 高清细节 / fine 都已是想要的那一版） | `src/ground/clipmap.ts` |
| 重建条件抽函数 | `update` 里的「要不要重建」抽成 `wanted(i, x, z)` + `rebuildReason(...)`，`unsettled()` 共用；逻辑与原来逐条相同（stale / 中心 / 细节 / `fine && !l.fine`） | 同上 |
| 换版计数与诊断 | `ground.uploads`（每换上一级 +1，在 after 里、与纹理写入 / 换中心同一帧）；`ground.events = []` 打开构建 / 换上事件记录（默认 null，不记）；`ground.levelState` | 同上 |
| groundSettle | 改为连续 10 帧 `unsettled()` 为 null 且 `uploads` 不变（原来是 250 ms 轮询 DX-26 判据 + 500 ms，会在帧间隙误判）；老页面（`--base` 指向旧提交）退回旧判据；`ground-on` 关着时直接返回；返回值加 `uploads` / `reason`；新增 `groundUploads(page)` | `scripts/lib/ab-live.mjs` |
| ab 冻结等待 + 作废 | 冻结后 `groundSettle`（去掉多余的 2 s）；每张图 JSON 记 `groundUploads`、`groundChanged`，与稳定时的基线不同即 `void`；变体级 `ground` 有意 rebuildAll 时基线跟着换 | `scripts/lib/ab.mjs` |
| flight | 带地面的场景冻结后也 `groundSettle` | `scripts/lib/ab.mjs` |
| shots / flicker | `shots --freeze` / `--pair`、`flicker` 带地面（`sc.ground`）的场景冻结后 `groundSettle`（各一行 + import）；ab 帮助文字两处 | `scripts/dev-browser.mjs` |
| gpu-ab | 没改代码，它已调 `groundSettle`，自动用上新判据 | — |
| 文档 | README「地面与数据」新增 G-FREEZE 坑点；T48b、W-LAMP 两条旧坑点加更正注；DEV_SOP 测量约定 night-city-off 那一句按结论改 | `README.md`、`DEV_SOP.md` |

main.ts 没有改（冻结逻辑本身无问题，不需要「冻结期间停止地面换版」）。没有采用「冻结时冻住地面」：ab 本来就依赖冻结后按钉回的机位把地面建好，冻住会让它永远停在飘走的机位上。

## 验收数字

**同代码重拍（`node scripts/dev-browser.mjs ab --port 5243 --jobs apps/voyage/handoff/G-FREEZE-jobs.json --rounds 3`，两个空变体 a / b 交替 3 轮 = 每场景 6 张，输出 `tmp/screenshot/G-FREEZE/ab1/`）**：

| 场景 | 就绪用时 | 6 张两两 mean / max / over8 | 作废 |
| --- | --- | --- | --- |
| night-city-low（1 km 夜城） | 25.5 s | 0 / 0 / 0 | 无 |
| night-city-off | 7.4 s | 0 / 0 / 0 | 无 |
| fuji-day | 9.6 s | 0 / 0 / 0 | 无 |
| route-hnd-cts-night | 9.4 s | 0 / 0 / 0 | 无 |

console error 0 条（瓦片跨域另计，也是 0）。

**正常飞行（抽测，对照 master 5303）**
- 首载（`handoff/G08-load.mjs 5303 5243 2`，冷缓存交替）：fuji-day 粗版 / 全 fine 中位 master 8508 / 14439 ms，G-FREEZE 8188 / 14374 ms；route-hnd-cts master 8712 / 15311，G-FREEZE 9029 / 15455（两轮 8413 / 9029，噪声内）。长任务数相同。
- 1× 巡航尖峰（`handoff/G08-spikes.mjs <端口> 60 2 G08`，hnd-cts 1×，各 2 × 60 s）：master 15571 帧、> 16.7 ms 0、长任务 0；G-FREEZE 15583 帧、> 16.7 ms 0、长任务 0。合成任务中位 447–521 ms 两边相同。

**作废检测正对照**（`handoff/G-FREEZE-jobs-void.json`：变体 js 里 `ground.rebuildAll()` 再等 3 s）：该张标「作废：冻结期间地面换版 7 次」；顺带看到原地重建出的画面与 a 逐位相同（重建本身是确定的）。

**其他**：typecheck、build 通过，`dist/assets` 0 字节文件 0 个，`check:glsl` 全部通过。

## 复现

```bash
# apps/voyage 下
node handoff/G-FREEZE-diag.mjs <端口> night-city-low,night-city-off 30   # 旧流程后逐秒哈希 + 各级状态 + 构建 / 换上事件
node scripts/dev-browser.mjs ab --port <端口> --jobs apps/voyage/handoff/G-FREEZE-jobs.json --rounds 3   # 同代码重拍，应全 0
```

页内：`__voyage.ground.unsettled()`、`.settled`、`.uploads`、`.levelState`、`.events = []`。

## 已知 / 没做

- `unsettled()` 按「上一次 update 的机位」算，刚改 `uCloudOffset` 还没跑一帧时会误报稳定——groundSettle 的「连续 10 帧」就是防这个；自己写等待时别只查一次。
- 瓦片失败（CORS / 5xx）的级别照样「稳定」（失败的瓦片留透明、下次重建才重试），这类仍由 ab 的 `corsErrors` 作废规则兜底。
- 白天低空日本、高清细节反复取不齐（DETAIL_WAIT_MS）时会一直重建，groundSettle 会等到 120 s 超时并报原因 `Lx detail`，属于如实报告。
- `applyScene` 自身的 `settle`（scenarios.mjs，只看 pending）没改：它在冻结之前，之后工具都会再等 groundSettle。regression.playwright.js（MCP 版）也没改。
