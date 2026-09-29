# UX-5 · 控件类型统一 · 交接

分支 `worktree-agent-a6ddc902251cd3ad7`，端口 5300。
规范 `research/PANEL_UX_GUIDE.md` §4.1（控件选型）、§5.3 规则五（流速合并）、§8.2（可访问性底线）；
审计 `research/PANEL_UX_AUDIT_1.md` 的 UX-5 条目（P5）。先读 `handoff/UX-3.md` / `UX-3-review.md`
（分区折叠）、`handoff/UX-4.md` / `UX-4-review.md`（手机抽屉），本任务在这两者的地基上改动。
状态：**完成**。归属文件（`index.html` / `src/ui.ts` / `src/style.css`）改动已做完，未碰
`scripts/scenarios.mjs` / `scripts/regression.playwright.js`（不需要——见下面「为什么没改场景表」）。
typecheck / build（`dist/assets` 无 0 字节文件） / check:glsl 全部通过，1600×1200 默认面板不滚动，
390×844 手机抽屉正常，控制台全程 0 error。

## 做了什么

1. **「流速」合并成一行**（PANEL_UX_GUIDE §5.3 规则五）：原来「时间流速」（4 按钮）与「航程流速」
   （3 按钮）是两行，连续航程开着时前一行整行变灰（截图 `tmp/screenshot/ux5-before/ux5-voyage-on-1600.png`）。
   改成一行「流速」，内部两组按钮（`#rate-time` 暂停/1×/60×/600×、`#rate-voyage` 1×/10×/60×）共用一条
   `role="group" aria-label="流速"` 容器，连续航程开 / 关时用 `hidden` 切换谁可见（`ui.ts` `setupVoyageUi`
   的 `sync()`），不再是禁用变灰。两组按钮各自的语义、范围、选中值完全不变，只是可见性换了个实现方式。
2. **座位 / 舱等 / 舱内灯光 / 稀有度换成分段按钮**（PANEL_UX_GUIDE §4.1：2–4 项互斥选项不该用下拉；
   离散 4 档不该用滑条）：
   - 座位（2 项下拉 → 2 按钮）、舱等（2 项下拉 → 2 按钮，材质说明仍在 `title`）、舱内灯光
     （3 项下拉 → 3 按钮，`睡眠`/`全关` 的括号说明挪进 `title`）、奇观稀有度（0–3 滑条 → 4 按钮：
     罕见/偶尔/常见/奇观巡礼）。
   - **真正的数据源没有变**：原来的 `<select>` / `<input type="range">` 全部原样保留在 DOM 里，只是加了
     `hidden`（全局 `[hidden]{display:none!important}` 规则，UX-1a 已建立），id、选项 `value` 一个没改。
     分段按钮是它的双向同步外壳（`src/ui.ts` 新增 `bindSegmented(groupEl, source)`）：点击分段按钮 →
     设隐藏控件的 `.value` → 派发 `change`（select）或 `input` + `change`（range）→ 触发 `ui.ts` 里已有的
     业务逻辑（一行没改）；反过来，脚本 / 场景表直接改隐藏控件的值并派发事件时，分段按钮的选中态也会跟着
     刷新（监听同一个 `change` / `input`）。

## 控件映射表

| 控件 | 原类型 | 现状 | 数据源 id（未改） | 选项 value（未改） |
| --- | --- | --- | --- | --- |
| 座位 | `<select>` | 分段按钮 `#seat-seg` | `seat` | `right` / `left` |
| 舱等 | `<select>` | 分段按钮 `#cabin-class-seg` | `cabin-class` | `business` / `economy` |
| 舱内灯光 | `<select>` | 分段按钮 `#cabin-light-seg` | `cabin-light` | `true` / `false` / `off` |
| 奇观稀有度 | `<input type="range">` 0–3 | 分段按钮 `#wonder-rarity-seg` | `wonder-rarity` | `0` / `1` / `2` / `3` |
| 时间流速 | 按钮组（`[data-rate]`） | 同一组按钮，外层容器 `#rate-time` 随连续航程隐藏 / 显示 | 无 id 契约（`state.playRate`，不在场景表按钮 id 里） | `0` / `1` / `60` / `600`（`data-rate`） |
| 航程流速 | 按钮组（`[data-voyage-rate]`） | 同一组按钮，外层容器 `#rate-voyage` 随连续航程隐藏 / 显示 | 无 id 契约（`director.rate`） | `1` / `10` / `60`（`data-voyage-rate`） |

## 为什么没改场景表

查过 `scripts/scenarios.mjs` 的 `applyScene` 与 `scripts/dev-browser.mjs` 的 `collectShotMeta`：两者都是
`document.getElementById(id).value/.checked` 这条路径，`PANEL_META_IDS` 来自 `scenarios.mjs` 的 `DEFAULTS`
键（`seat`、`cabin-class`、`cabin-light`、`wing-pos`、`vehicle`……）。这些 id 现在仍然指向隐藏的原生
`<select>` / `<input>`，`set()` 的 `el.tagName === "SELECT"` / `el.type === "checkbox"` 判断逻辑完全不受影响。
「时间流速」「航程流速」本来就不是按 id 设值的契约（`applyScene` 用 `sc.playRate` / `v.director.setActive`
单独处理，见 `scenarios.mjs` 第 163–171 行注释），所以合并成一行不涉及场景表。`check:glsl` 的
「scenarios.mjs ↔ regression.playwright.js 场景表同步」检查照常通过（两处没改）。

## 键盘 / 可访问性

- 新增的分段按钮（`bindSegmented`）与既有的时间流速 / 航程流速按钮统一走 `addSegmentedArrowNav()`：
  Tab 停留在每个按钮上（原生行为）、Enter / Space 选中（原生 `<button>` 行为）、方向键（← → 或 ↑ ↓）
  在组内移动焦点并像点击一样选中。选中态复用既有的 `setPressed()`（`.on` 类 + `aria-pressed`）。
- **踩到并修了一个坑（已写进 README「工具与环境」）**：`ui.ts` 的全局方向键转弯监听
  （`ownsArrowKeys()`）只认 input / select / textarea / contentEditable「拥有」方向键，普通 `<button>`
  不算，所以给分段按钮加方向键导航时，方向键会同时把飞机也转了（`v.state.heading` 跟着变）。修法：
  `addSegmentedArrowNav` 的 keydown 处理里 `preventDefault()` 之外还要 `stopPropagation()`，阻止事件
  冒泡到 `window` 上的转弯监听。已用截图脚本验证：方向键操作分段按钮时 `v.state.heading` 不再变化
  （见下方「验收结果」）。

## 验收结果

| 项 | 结果 |
| --- | --- |
| typecheck / build（`dist/assets` 0 字节文件） / check:glsl | 全部通过 |
| 1600×1200 默认面板不滚动 | 通过，`scrollHeight === clientHeight === 1106`（UX-3 记录的基线是 1102，多出的 4px 是「流速」合并成一行后的容器换行余量，仍在可视区 1168px 内，不需要滚动） |
| 390×844 手机抽屉正常 | 通过，展开态 `panel-body` 实测 390×291.6（≤ 40vh=337.6px 上限） |
| 场景表设值（`seat`/`cabin-class`/`cabin-light`）逐位生效 | 通过：脚本按 id 设 `left`/`economy`/`off` 后，分段按钮选中态与 `v.state.seat`/`v.state.cabinClass`/`v.state.cabinLight` 全部匹配（`ux5-set-by-id-1600.json`） |
| 奇观稀有度脚本设值 | 通过：设 `wonder-rarity.value='3'` 并派发 `input` 后，分段按钮选中「奇观巡礼」，`v.wonders.rarityPerHour === 6` |
| 连续航程接管时流速显示 | 通过：关闭时 `#rate-time` 可见、`#rate-voyage` 隐藏（暂停/1×/60×/600×）；打开后互换（1×/10×/60×），无整行变灰 |
| 键盘 Tab / 方向键 / Enter | 通过：ArrowRight 移焦点到下一个按钮并选中（`seat` 从 `right` 变 `left`），ArrowLeft 移回并选中；两次操作 `v.state.heading` 均未被顺带改动 |
| 控制台 0 error | 通过（全部截图 / 回归场景） |
| 回归场景抽测（noon-cumulus、storm-sc、dusk-earthshadow、night-city-on/off、economy-ahead） | 通过，0 console error / pageerror |

### 前后截图（`tmp/` 已忽略，路径供复现；均 `d3d11`、`voyage=0`，除接管场景显式设 `voyage-on`）

| 场景 | 改前 | 改后 |
| --- | --- | --- |
| 1600×1200 默认 | `tmp/screenshot/ux5-before/ux5-default-1600.png` | `tmp/screenshot/ux5/ux5-default-1600.png` |
| 1600×1200 连续航程开（流速接管） | `tmp/screenshot/ux5-before/ux5-voyage-on-1600.png`（时间流速整行变灰） | `tmp/screenshot/ux5/ux5-voyage-on-1600.png`（流速换成航程流速三档，无灰按钮） |
| 390×844 抽屉展开 | `tmp/screenshot/ux5-before/ux5-mobile-390.png` | `tmp/screenshot/ux5/ux5-mobile-390.png` |

## 复现

```bash
pnpm --filter voyage exec vite --port 5300 --strictPort --host 127.0.0.1

# 桌面场景（自定义 scenes-file，脚本已删未进仓库，js 字段见下）
node apps/voyage/scripts/dev-browser.mjs shots --port 5300 --angle d3d11 --viewport 1600x1200 \
  --out apps/voyage/tmp/screenshot/ux5 --scenes-file apps/voyage/tmp/screenshot/ux5/scenes-desktop.json --query "voyage=0"

# 手机抽屉
node apps/voyage/scripts/dev-browser.mjs shots --port 5300 --angle d3d11 --viewport 390x844 \
  --out apps/voyage/tmp/screenshot/ux5 --scenes-file apps/voyage/tmp/screenshot/ux5/scenes-mobile.json --query "voyage=0"

# 场景 js 写法（举例，验证分段按钮与隐藏数据源双向同步）：
#   const segOk=(id,src)=>{const g=document.getElementById(id);const btns=[...g.querySelectorAll('button')];
#     const on=btns.filter(b=>b.classList.contains('on'));
#     return {onValue:on[0]?.dataset.value, matches:on[0]?.dataset.value===document.getElementById(src).value};};
#   return JSON.stringify({seat:segOk('seat-seg','seat'), cabinClass:segOk('cabin-class-seg','cabin-class')});

# master 对照（临时 worktree，跑完已删除）
git worktree add --detach tmp/ux5-base master
cd tmp/ux5-base && pnpm install
pnpm --filter voyage exec vite --port 5390 --strictPort --host 127.0.0.1
```

## 开发体验反馈

- **哪里慢**：想清楚「流速合并」的实现方式花了一点时间——一开始想直接改 `[data-rate]` / `[data-voyage-rate]`
  按钮本身的 disabled/hidden 逻辑，后来发现最省事的做法是给两组按钮各包一层 `<span>` 容器（`#rate-time` /
  `#rate-voyage`），只切容器的 `hidden`，业务逻辑（`state.playRate` / `director.rate` 的赋值）完全不用碰。
- **哪里卡**：给分段按钮加方向键导航时，最初没意识到 `ownsArrowKeys()` 不认 `<button>`，方向键会把飞机
  也转了——这个坑不是文档里写明的，是靠一个专门测 `v.state.heading` 前后是否变化的截图场景才抓到的。
  已经写进 README「工具与环境」，以后任何新的按钮组方向键导航照着办即可（`preventDefault` + `stopPropagation`
  一起写）。
- **怎么绕过去的 / 想要什么**：`bindSegmented()` 写成通用函数后，四个控件（座位/舱等/舱内灯光/稀有度）
  复用同一份逻辑，只传「按钮组容器 + 隐藏数据源元素」两个参数；如果 `PANEL_UX_GUIDE.md` §10 的
  `panel-kit.ts` 框架落地，`bindSegmented` 这段可以直接并进 `kind: "segmented"` 的渲染器里，不用重写。
