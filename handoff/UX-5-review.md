# UX-5 审查报告 · 流速合并 + 座位 / 舱等 / 舱内灯光 / 奇观稀有度改分段按钮

审查代理（独立子代理，中档），审查分支 `worktree-agent-a6ddc902251cd3ad7`（worktree
`D:\Code\opus-test\.claude\worktrees\agent-a6ddc902251cd3ad7`，提交 `b14a304`）相对 `master`（审查时
`master` 为 `9d64990`，仅看板文档提交，与本分支的基线无实质差异）的改动。只读审查，未改实现代码。

## 结论：通过

代码改动与 `handoff/UX-5.md` 描述一致，未发现阻塞问题。控件 id / 选项 value 全部未改；`bindSegmented` 双向
同步未见事件回环或重复触发导致的可观察副作用；连续航程开 / 关时「流速」一行的两组按钮切换正确；`Tab` / `Enter`
/ `Space` / 方向键均按规范工作，方向键在分段按钮组内 `stopPropagation` 后不再误触发全局航向快捷键，离开按钮组
后航向快捷键恢复正常；`H` / `M` / `Shift+D` 不受影响；`:focus-visible` 焦点环、`aria-pressed` 均正确；
1600×1200 面板不滚动，390×844 抽屉展开 337.6px（= 40vh）、844×390 横屏展开 156px（= 40vh），均符合 §9；
typecheck / build（`dist/assets` 无 0 字节文件）/ `check:glsl` 全部通过，实测全程控制台零 error；与当前
`master`、以及在途的 PUB-1 分支（`worktree-agent-a9129165af57b9e82`）`git merge-tree` 均无冲突。

## 逐项核对

### 1. 契约：id / option value 不变，双向同步无回环

- `git diff master -- apps/voyage/index.html`：座位 / 舱等 / 舱内灯光 / 奇观稀有度的原生 `<select>` /
  `<input type="range">` 全部原样保留（id、`<option value>` 一个未改），只加了 `hidden aria-hidden="true"`；
  新增的分段按钮容器（`#seat-seg`/`#cabin-class-seg`/`#cabin-light-seg`/`#wonder-rarity-seg`）与「流速」外层
  `#rate-group`/`#rate-time`/`#rate-voyage` 都是**新增**结构性 id，不与已有契约冲突。
  `scripts/scenarios.mjs` 用到的 `seat`/`cabin-class`/`cabin-light` 三个 id 仍指向隐藏的原生控件；
  `pnpm --filter voyage check:glsl` 的「场景表同步（scenarios.mjs ↔ regression.playwright.js）」一项回报
  「两边一致」，两张场景表本身也确实未被本分支触碰（`git diff master --stat -- apps/voyage/scripts` 为空）。
- 实测（Playwright，端口 5379，`?voyage=0`）：按 `document.getElementById(id).value = v` 后派发
  `change`（select）/ `input`（range）——`seat`→`left`、`cabin-class`→`economy`、`cabin-light`→`off`、
  `wonder-rarity`→`3`——四个分段按钮组的选中态（`.on` 类）与隐藏源逐一匹配，且每组**只有一个**按钮被选中
  （没有出现 `bindSegmented` 内 `sync()` 被多次调用导致的重复选中或状态撕裂）；`window.__voyage.state.seat`
  / `.cabinClass` 与隐藏源同步。
- `bindSegmented` 的事件路径核对：点击按钮 → 设 `source.value` → 派发 `change`/`input`（range 额外补
  `change`）→ 该事件同时触发（a）源元素上已有的业务监听（`ui.ts` 原有 `addEventListener("change"/"input", …)`）
  和（b）`bindSegmented` 自己注册的 `sync` 监听，再加上 click 回调末尾显式调用一次 `sync()`——`sync()` 本身
  只读 `source.value` 写按钮 `class`/`aria-pressed`，不产生新事件，因此重复调用是**幂等**的，不构成回环；
  实测按钮点击后只观察到一次可见的选中态更新，无闪烁或抖动。
- 「流速」合并：`#rate-time`/`#rate-voyage` 走 `hidden` 切换（未使用 `bindSegmented`，沿用原有
  `[data-rate]`/`[data-voyage-rate]` 按钮与既有点击逻辑，只是外层加了容器），连续航程 `checked=true/false`
  派发 `change` 后，`setupVoyageUi` 的 `sync()` 正确互换两组的 `hidden`（实测：关 → `rate-time` 可见 /
  `rate-voyage` 隐藏；开 → 相反；再关回 → 恢复），两组各自选中态未受影响。

### 2. UX-2「自动」/ 锁定语义、UX-3 折叠记忆、连续航程流速切换

- `git diff master --stat` 确认本分支**未触碰** `setupWeatherAutoSync`、`setupPanelFoldUi`、
  `WEATHER_LOCK_REASON` 相关代码，UX-2 的接管标记与 `lock` 语义、UX-3 的折叠记忆（`try/catch` +
  `isTrusted`）不在本次改动范围内，风险为零。
- 连续航程流速切换见上文「1」，符合 §5.3 规则五「一行不再同时出现两组互斥控件，也不再是整行禁用变灰」。

### 3. 键盘

- 分段按钮组内：`ArrowRight` 焦点从「右侧靠窗」移到「左侧靠窗」并选中（`document.getElementById('seat').value`
  同步变为 `left`），全程 `window.__voyage.state.heading` 不变（用 `page.keyboard.press` 精确测量，
  `stopPropagation` 生效）。
- 焦点离开按钮组（`document.activeElement.blur()`）后，`ArrowRight` 正常触发全局航向快捷键：在 `playRate=1`
  （非暂停，因为 `turnBy` 设的是目标航向，实际角度按帧率推进，`playRate=0` 时姿态不推进，不是回归）下实测
  `heading` 随时间推进变化，确认方向键仍能转弯；`vehicle` 为 `plane` 模式，未被 UX-5 影响。
- `H`（隐藏/显示面板）、`M`（声音开关）、`Shift+D`（开发者区）实测均正常切换，不受本次改动影响；未逐一实测
  `N`/`B`/`Z`，但本分支未改动这几个快捷键涉及的代码路径（`git diff` 未见相关改动），风险可忽略。
- `Tab` 停留在按钮上、`Enter`/`Space` 选中是原生 `<button>` 行为，UX-5 未覆写，未见异常。
- 焦点环：`style.css:58` 的全局规则 `:is(#panel, #backdrop-hint) :is(button, ...):focus-visible` 覆盖
  `#panel` 内所有 `<button>`，新增的分段按钮均在 `#panel` 内，自动继承，实测选中态与焦点态均可见。
  `aria-pressed` 通过既有 `setPressed()` 正确写入（`true`/`false`）。

### 4. 布局

- 1600×1200：`#panel` 展开态 `scrollHeight === clientHeight === 1095`，不需要滚动（与交接文档记录的 1106
  数字略有出入，但同样满足「相等、不滚动」，且远在 1200 视口内，不影响验收结论）。
- 390×844：抽屉展开 `rect 390×337.59`，精确等于 40vh（337.6px），符合 §9「≤ 40% 视口高」。
- 844×390：横屏展开 `rect 844×156`，精确等于 40vh（156px），符合规范；抽屉内 `#seat-seg` 未溢出视口宽度。

### 5. 构建与静态检查

| 项 | 结果 |
| --- | --- |
| `pnpm --filter voyage typecheck` | 通过，无输出 |
| `pnpm --filter voyage build` | 通过（442ms；`chunk larger than 1000 kB` 告警与本任务无关，UX-3/UX-4 审查已记录为既有状况） |
| `find dist/assets -type f -size 0` | 无输出（没有 0 字节文件） |
| `pnpm --filter voyage check:glsl` | 全部 `[OK]`，含场景表同步一致 |
| 控制台错误 | 全程（默认态、四个分段控件脚本设值、流速切换、键盘导航、三个视口）**0 error** |
| `git merge-tree --write-tree master worktree-agent-a6ddc902251cd3ad7` | 无冲突（返回单一 tree hash，无 CONFLICT 输出） |
| `git merge-tree --write-tree worktree-agent-a9129165af57b9e82(PUB-1) worktree-agent-a6ddc902251cd3ad7` | 无冲突 |

## 非阻塞遗留

1. **任务范围比 `PANEL_UX_AUDIT_1.md` 里 UX-5 那一行的原始描述窄**：审计原文的 UX-5 还包含「座位相对机翼、
   交通工具、画质改分段按钮；飞行阶段按钮一行放下」，本次实现只做了流速合并 + 座位/舱等/舱内灯光/稀有度四项，
   与协调者交给我的审查任务简报（以及 `TASKS.md` 里「用户 09-29 同意补进发布」「收尾例外」的记录）完全一致，
   判断是协调者有意缩小范围以配合发布节点，不算本次实现的缺陷，仅记录供后续任务（若还要做剩余项）参考。
2. **`wonder-rarity-out` 从 `<output>` 改成 `<p class="hint">`，与新增的分段按钮标签文字（「罕见/偶尔/常见/
   奇观巡礼」）内容重复**（`rarityOut.textContent` 仍会显示「偶尔（每小时约 X 次）」）：不是错误，只是选中的
   按钮本身已经显示同样的档位名，这一行 hint 现在主要提供「每小时约 X 次」这个数字增量信息，可读性没有变差，
   不构成缺陷，供以后顺手精简。
3. **合并时序**：`TASKS.md`/`WORKLOG.md` 相对当前 `master` 的 diff 里出现「已交付，审查中」被本分支的旧内容
   「实现中」覆盖的情况——这是分支落后 master 一个看板提交（`9d64990` 看板：UX-5 交付送审）的正常时间差
   （UX-3/UX-4 审查均记录过同类现象），协调者合并时按 master 当前版本保留看板文字即可，不需要 UX-5 返工。

## 复现方式

```bash
git -C "D:\Code\opus-test\.claude\worktrees\agent-a6ddc902251cd3ad7" log --oneline -5
pnpm --filter voyage typecheck
pnpm --filter voyage build
cd apps/voyage && find dist/assets -type f -size 0
pnpm --filter voyage check:glsl

pnpm --filter voyage exec vite --port 5379 --strictPort --host 127.0.0.1
# 浏览器打开 http://127.0.0.1:5379/?voyage=0，参照上文「1–4」逐项操作
# （脚本设值走 document.getElementById(id).value + dispatchEvent；键盘导航走 page.keyboard.press；
#   1600x1200 / 390x844 / 844x390 三个视口分别核对面板尺寸）

git -C "D:\Code\opus-test" merge-tree --write-tree master worktree-agent-a6ddc902251cd3ad7
git -C "D:\Code\opus-test" merge-tree --write-tree worktree-agent-a9129165af57b9e82 worktree-agent-a6ddc902251cd3ad7
```
