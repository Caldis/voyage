# UX-3 审查报告 · 面板分区折叠 + 调试控件进开发者区

审查代理（独立子代理，中档），审查分支 `worktree-agent-ad8ed612d2a656888`（worktree
`D:\Code\opus-test\.claude\worktrees\agent-ad8ed612d2a656888`）相对 `master`（审查时 `master` 为
`6fbcf08`，仅看板文档提交，与本分支已合并的基线无实质差异）的改动。只读审查，未改代码。

## 结论：通过

代码改动与 `handoff/UX-3.md` 交接文档描述完全一致，未发现阻塞问题。控件 id / 选项 value 除交接文档明确声明的
一处修复（`focus-vignette` → `focus-vig`）外一个未改；与 master 的合并冲突解决正确，STROBE-CLOUD / SPEC-BOW /
SEA-3 / W-EDGE / FOCUS-ZOOM / REFLECT-OFF 的面板接线全部保留；折叠状态记忆的 `try/catch`、`isTrusted` 守卫
均按规范实现且经过实测验证；快捷键守卫、`Z` 聚焦、`Shift+D` 开发者区均正常工作；typecheck / build /
`check:glsl` / `find dist/assets -type f -size 0` 全部通过；实测 1600×1200 默认面板不需要滚动、
390×844 与 master 逐位相同、展开开发者区无残留横杠、全程控制台零 error。

## 逐项核对

### 1. 控件 id / option value 是否真的没变

- 对比 `master` 与本分支 `index.html` 的全部 `id="..."` 集合（排序去重后 diff）：仅新增了本任务声明的结构性 id
  （`section-view/voyage/weather/sound/quality/footer`、`now-line1/2/3`、`weather-summary`、
  `sound-summary-text`、`quality-summary`）与一处改名（`focus-vignette`/`focus-vignette-out` →
  `focus-vig`/`focus-vig-out`），没有任何 master 已有的控件 id 被删除或漏改。
- 确认 master 里 `focus-vignette` 这个 id 确实同时用在 `focus-zoom.ts` 的叠层 `<div>`（`index.html:15`）和开发者区
  滑条（`index.html:212`）上，是真实存在的 id 冲突，本分支修复后叠层 div 的 id 未动，滑条改名为 `focus-vig`，
  `ui.ts` 的 `bind("focus-vig", ...)`（`src/ui.ts:1106`）与 README「工具与环境」坑点条目同步更新，未见遗漏引用。
- `<option value="...">` 全量对比（排序后）：master 与本分支完全一致（29 个，逐值相同，只是因分区搬家导致文档序
  不同）。
- `scripts/scenarios.mjs`（`DEFAULTS` + 全部 `SCENES` 的 `p` 字段用到的 16 个 id：`altitude` /
  `cabin-class` / `cabin-light` / `cloud-preset` / `coverage` / `date` / `ground-on` / `preset` / `seat` /
  `shade` / `time` / `vehicle` / `view-preset` / `weather` / `wind` / `wing-pos`）在本分支 `index.html`
  中逐一确认存在且各只出现一次（无重复 id）。
- `git diff master...HEAD --stat` 确认本分支**没有改动** `scripts/scenarios.mjs` 与
  `scripts/regression.playwright.js`；`pnpm --filter voyage check:glsl` 自带的「场景表同步
  （scenarios.mjs ↔ regression.playwright.js）」检查项也回报「两边一致」，独立佐证两表未被改动、未被改坏。
- input / select / button / option 的元素总数（`<input`/`<select`/`<button`/`<option` 计数）master 与本分支
  完全相等（25/15/22/29），排除了「隐藏删除某个控件」的可能。

结论：控件契约完整保留，唯一的 id 改动是交接文档明确声明、且确实是在修复一个真实 bug（滑条此前从未真正生效过），
不影响任何场景表依赖。

### 2. 与 master 合并的冲突解决

- `updateInfo`（`src/ui.ts:130`）的函数签名与 `info.textContent` 拼接逻辑与 master 逐字节相同，本分支只在其后
  追加了 `nowLine1/2/3` 的赋值逻辑，没有改动原有的开发者区完整信息栏文本、也没有改动 `strobeCloudOff` 参数处理。
  `main.ts:624` 的调用点（`updateInfo(now, sun, moon, state, curLat, curLon, ground.pending, ...,
  strobeCloud.off)`）与 master 完全一致，未改。
- `#now-line3` 的存在与隐藏逻辑（`nowLine3.hidden = !strobeCloudOff`，`src/ui.ts:162-163`）正确保留了 STROBE-CLOUD
  「不对用户静默」的原意，样式上用 `--accent` 色区分（`src/style.css` 新增的 `#now-line3` 规则）。
- 对比 master 与本分支 `ui.ts` 里全部 `function setup[A-Za-z]+` 定义：master 的 10 个 `setupXxxUi` 全部保留
  （`setupDevSection`、`setupFocusUi`、`setupMinimapUi`、`setupNavUi`、`setupReflectUi`、`setupSoundUi`、
  `setupVehicleUi`、`setupVoyageUi`、`setupWeatherAutoSync`、`setupWonderUi`），只新增了
  `setupPanelFoldUi`、`setupQualitySummary` 两个。`main.ts` 对这些函数的调用点（`grep -n "setup...("）`
  与 master 逐行相同（无 diff）。`ui.ts` 导出函数列表（`export function`）与 master 完全一致。
- 抽查 `index.html` 里 STROBE-CLOUD / SPEC-BOW / SEA-3 / W-EDGE / FOCUS-ZOOM / REFLECT-OFF 相关的控件
  （天气区的 `weather-auto`/`cloud-preset-auto`/`coverage-auto`/`cloud-base-auto`/`cloud-thick-auto`/
  `wind-auto` 自动标记、`reflect` 滑条、开发者区 `focus-mag`/`focus-ms`/`focus-vig`）均按 UX-3 的分区搬家规则
  原样迁移到位，未见丢失。

结论：合并冲突解决正确，没有回退或丢失其他任务的面板接线。

### 3. 折叠状态记忆（`localStorage voyage.pref.panel.sections`）

- 代码位置：`setupPanelFoldUi`（`src/ui.ts:1026-1050`）。读取与写入均包在 `try/catch` 里，`catch` 分支不做任何
  操作（按默认值继续），符合「拿不到 localStorage 就按默认」的要求。
- 写入前判断 `toggle` 事件的 `e.isTrusted`，非可信事件（脚本触发）直接 `return`，不写记忆。
- 实测（Playwright，端口 5349，`?voyage=0`）：
  - 清空 `localStorage` 后刷新，`section-view`/`section-voyage` 展开、`section-weather`/`section-sound`/
    `section-quality`/`section-footer` 折叠，`localStorage.getItem('voyage.pref.panel')` 为 `null`，
    面板 `scrollHeight === clientHeight === 1090`（不需要滚动）。
  - 直接对 `<details>.open` 属性赋值（模拟回归脚本可能的操作方式）**不会触发 `toggle` 事件**（验证：注册
    `toggle` 监听器后 `el.open = true`，50ms 内无事件触发），因此不会写记忆，与交接文档「回归 / 截图脚本用
    `sc.js` 直接设 `.open` 属性不触发 toggle，不会写记忆」的说法一致（且当前 `scripts/scenarios.mjs` 也确实
    没有触碰任何 `section-*` id，这条风险目前是空的）。
  - 用 Playwright 真实点击（`browser_click`，`isTrusted: true`）折叠区标题，`localStorage` 正确写入
    `{"v":1,"sections":{...}}`，刷新后状态保持。
  - 把 `Storage.prototype.getItem` / `setItem` 都替换成抛异常（模拟隐私窗口拿不到 storage），再触发折叠：
    折叠动作本身正常完成（`open` 状态照常切换），未抛出未捕获异常，控制台零 error——`try/catch` 生效。
  - 一个值得记录但**不构成缺陷**的浏览器行为细节：`.click()`（无论是脚本调用还是真实点击）触发的原生
    `<details>` `toggle` 事件在本地 Chromium 里 `isTrusted` 均为 `true`（区别只在直接赋值 `.open` 属性
    完全不触发 `toggle`）。这意味着 `isTrusted` 守卫实际上只精确防住了「脚本直接改 `.open` 属性」这一种
    自动化方式，如果未来有工具改用 `element.click()` 操作折叠区，也会被当成「用户亲手操作」写入记忆。
    当前 `scripts/scenarios.mjs` / `regression.playwright.js` / `dev-browser.mjs` 均不触碰
    `section-*` 这几个 id，所以现状没有实际风险；记在下面「非阻塞遗留」，供以后维护回归脚本的人参考。

结论：折叠记忆实现符合规范，try/catch 与 isTrusted 守卫按预期工作。

### 4. 快捷键守卫、Z 聚焦、Shift+D 开发者区

- `isTypingTarget` / `isLetterShortcut`（`src/ui.ts:46-55`）与 master 逐字节相同，未被本任务改动。
- 实测：焦点在 `#date` 日期框时按 `H`，面板不隐藏；焦点移开后按 `H`，面板正确切换隐藏 / 显示。
- 实测：`keydown 'z'` 后 `window.__voyage.focus.active` 变 `true`，`keyup` 后约 350ms 内变回 `false`
  （按住聚焦、松开还原，含过渡时间）。
- 实测：`Shift+D` 正确切换 `#dev-section.hidden`；展开后截图确认无残留横杠（`focus-vig` 滑条位置正常，
  不再铺满面板），`document.querySelectorAll('[id="focus-vignette"]')` 只有 1 个元素（叠层 div），
  `focus-vig` 单独存在，拖动后 `window.__voyage.focus.vignette` 从 `0.4` 正确变为 `0.9`（此前的 bug
  已被证实修复）。

结论：快捷键与开发者区行为符合预期。

### 5. 实测环境与结果

自建 dev server：`pnpm --filter voyage exec vite --port 5349 --strictPort --host 127.0.0.1`，
Playwright 打开 `http://127.0.0.1:5349/?voyage=0`。

| 项 | 结果 |
| --- | --- |
| `pnpm --filter voyage typecheck` | 通过，无输出 |
| `pnpm --filter voyage build` | 通过（`tsc --noEmit && vite build`，451ms） |
| `find dist/assets -type f -size 0` | 无输出（没有 0 字节文件） |
| `pnpm --filter voyage check:glsl` | 全部 `[OK]`，含「场景表同步（scenarios.mjs ↔ regression.playwright.js）：两边一致」 |
| 1600×1200 默认面板 | `scrollHeight === clientHeight === 1090`，不需要滚动 |
| 全部展开后面板 | `scrollHeight 1211/1761 > clientHeight 1168`，超出后正常在面板内滚动（预期行为，展开态不要求免滚） |
| 390×844 | `rect 358×380`，与交接文档所述、master 基线一致（该尺寸下的真正改善留给 UX-4，本任务只要求「不更差」，确认符合） |
| 展开 / 折叠各区 | 天气 / 声音 / 画质 / 页脚均可正常展开折叠，摘要行文字正确（如「晴天积云 42%」「关」「自动 → 高」） |
| 开发者区展开 | 无残留横杠，各控件（聚焦倍率/过渡/暗角、小地图、立即到达、召唤三件套、完整信息栏）排列正常 |
| 控制台错误 | 全程 0 error（含默认态、展开全部区、`Shift+D`、拖动 `focus-vig`、隐私模式模拟、H/Z 快捷键测试等操作后逐次检查） |

补充说明：首次用 Playwright 的 `browser_console_messages` 时误加了 `all: true`，把此前一次不同页面
（同一浏览器会话曾打开过的对照 `5188` 页签）的历史控制台记录也拉了进来，一度看到大量
`tiles.maps.eox.at` 的 CORS 报错，排查后确认是查询参数用法问题（跨导航历史记录被一并返回），并非本分支
或本环境的真实回归；按页面单独重新核对（不带 `all: true`）后两个端口均为 0 error。此为审查方法论笔记，
不计入分支问题。

## 阻塞问题列表

无。

## 非阻塞遗留

1. **折叠记忆的 `isTrusted` 守卫只精确防住「脚本直接赋值 `.open` 属性」，不防「脚本调用 `.click()`」**
   （见上文「3. 折叠状态记忆」）。当前所有回归 / 截图工具都不触碰 `section-*` 这几个 id，现状零风险；
   建议以后写涉及折叠区的自动化脚本时，统一用 `el.open = true/false` 而不是 `.click()`，或者在
   `PANEL_UX_GUIDE.md` §7.3 补一句「脚本改折叠区状态一律用 `.open` 属性，不要 `.click()`」，把这条约束
   显式沉淀下来，避免以后有人写 `.click()` 版本的辅助脚本时悄悄污染用户的折叠记忆。
2. `pnpm --filter voyage build` 有 `chunk larger than 1000 kB` 的构建告警——与本任务无关（本任务未改
   打包配置，属于既有状况），仅记录不阻塞。
3. 390×844 下面板仍压住舷窗中心、面积占比约 41.3%——这是交接文档与审计报告都明确标注「留给 UX-4」的既有
   问题，本任务范围内验收标准是「不更差」，已核实与 master 逐位相同，不算本任务遗留。

## 复现方式

```bash
git -C "D:\Code\opus-test\.claude\worktrees\agent-ad8ed612d2a656888" log --oneline -5
pnpm --filter voyage typecheck
pnpm --filter voyage build
cd apps/voyage && find dist/assets -type f -size 0
pnpm --filter voyage check:glsl
pnpm --filter voyage exec vite --port 5349 --strictPort --host 127.0.0.1
# 浏览器打开 http://127.0.0.1:5349/?voyage=0，参照上文「5. 实测环境与结果」逐项操作
```
