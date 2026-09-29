# VOY-HKG 独立审查（CPU 侧航线逻辑）

分支 `worktree-agent-ab0c0da1a1ac24141`，审查提交 `c1887be`（相对 `master` @ `732fc61`）。

## 结论：通过

未发现阻塞问题。改动本身（`excludeCode` 排除自环 + `jump` 时机头/坡度瞬间对准）思路正确、覆盖了全部预设、验收数字可独立复现。有一处非阻塞的代码可达性问题（见下），不影响本次交付。

## 复核过程

1. **代码走读**：`src/director.ts` 的 `joinNetwork(jump)` 及三条调用路径（`setActive`、`onPresetChanged`、`resumeRoute`）、`src/routes.ts` 的 `nearestAirport`/`airportAhead` 的 `excludeCode` 改动、`scripts/check-routes.mts`。
2. **离线断言**：`pnpm --filter voyage check-routes` — 全部通过，8 预设首段表与 `handoff/VOY-HKG.md` 记录完全一致（`scs`: HKG→CAN 625 km/344°/转角119°；`yangtze`: SHA→PVG 594 km/71°/转角1°；其余同表）。
3. **浏览器验收**：自己起 `vite --port 5359`，独立跑实现者的 `handoff/VOY-HKG-check.mjs`（未改动脚本本身，走真实 UI：`voyage=1` 首载 + 面板「地点」下拉真实切换，不直调 `setPreset()`）。9 个下拉项（8 预设 + 联动项 `leg-HND-KIX`）× 3 项断言，27/27 全部 `[OK]`：首段起终点均不同，`bankDeg` 在 2.27–2.67 s 内收敛到 ≤5°（`maxBankDeg` 实测 0.01–0.06°，几乎无可感知转弯），控制台零 error。数字与 handoff 报告（2.3–2.8 s）同量级，可独立复现。`scs-60s.png` 截图确认：机翼平直、面板显示「航段 HKG → CAN（香港 → 广州白云，625 km），巡航，1×」，窗外是正常巡航海景，不再是「一直转弯、窗外只有海」。
4. **构建与静态检查**：`pnpm typecheck` 通过；`pnpm --filter voyage build` 通过，`find apps/voyage/dist/assets -type f -size 0` 0 个；`node apps/voyage/scripts/lint-shaders.mjs`（`check:glsl`）全部通过。
5. **与 master 试合并**：`git merge --no-commit --no-ff` 到一次性临时 worktree（未污染仓库分支）。仅 `apps/voyage/README.md` 一处 `changed in both`（master 自己也改过这份坑点列表），Git 自动合并成功（`Auto-merging apps/voyage/README.md`），无冲突标记；合并预演后 `merge --abort` 并移除临时 worktree。

## 逐项核对（对应审查任务的三个重点）

### 1. `joinNetwork(jump)` 三条调用路径

- **`setActive(on, jump)`**：`ui.ts:502` 勾选框事件处理器仍是 `director.setActive(voyageBox.checked)`（不传第二参，默认 `jump=false`）——确认「用户手动勾选连续航程时保留『照常转』」这条没有被改动。`jump=true` 只在 `ui.ts:582` 的 `startVoyageByDefault()`（首载）里传入，这是 VOY-DEFAULT 已确立的既有语义，本任务只是把 `joinNetwork` 内部同样接了 `jump` 透传，行为不变。
- **`onPresetChanged()`**：换到非航线预设且 `active` 时传 `jump=true`。这个函数本身就是既有的「跳变」语境——同一次调用里，本地坐标原点已经换、`weather.onJump()`（无条件，函数末尾）也会跟着执行，云场/雷暴/台风全部重置。机头与坡度瞬间对准和这些重置是**同一个同步调用栈内**完成的，不存在「其他都已经跳变、只有航向还在慢慢转」的中间帧可以被用户看到——反而是修复了旧代码里「场景已经瞬间换了，飞机却还压着坡度转一两分钟」这个更割裂的观感。没有发现新的画面跳变风险。
- **`resumeRoute()`**：`this.leg && s.preset.dest` 为假时传 `jump=true`（「没有缓存航段、凭空接入航线网」分支）。追了一遍代码：`this.leg` 在整个代码库里**只在 `onPresetChanged()` 里被置空**（`director.ts:259`），而且置空后如果 `this.active` 为真，会在**同一次 `onPresetChanged()` 调用内**立即被 `joinNetwork(true)` 重新赋值（`director.ts:262`），中间没有任何返回给外部代码的机会；`main.ts`/`ui.ts` 没有其它地方直接写 `director.leg`。也就是说，`this.leg === null && this.active === true` 这个状态组合在当前调用图下**不会被外部代码观察到**——`resumeRoute()` 里 `else if (this.active) joinNetwork(true)` 这条分支**目前不可达**（27 项浏览器验收也确实没有一项触发到它，因为没有触发路径）。
  这不是一个运行时缺陷（死代码不会跑出错误行为），但 `handoff/VOY-HKG.md` 里把它写成「没有缓存航段、连续航程开着时，传 true（同样是『凭空接入航线网』…）」，读起来像是验证过的一条真实生效路径，容易让后来者以为这条分支被测过。**非阻塞**，建议以后要么在注释/handoff 里注明「当前不可达，为将来若有代码把 `leg` 置空时的防御」，要么干脆去掉（对称性好看但没有实际作用）。同时顺带确认：这条分支即便将来变得可达，也没有像另外两条路径那样调 `weather.onJump()`——但这是**自洽的**，不是遗漏：该分支触发时位置没有变化（只有航向瞬间对齐），天气场按经纬度采样，不需要跟着重置；不要在以后被误当成 bug 补上。

### 2. `excludeCode` 之后终点的合理性 + 数据真实性

- 手工复算 `scs` 预设（18.0°N 115.0°E，航向 225°，排除 HKG）全部候选打分：`CAN` 2277 分，第二名 `TPE` 4927 分、`SHA`/`PVG` ~7200+，差距接近 2 倍以上——`CAN` 是压倒性的最优解，不是排除最近机场后矮子里拔出一个更离谱的反方向远机场。且因为 `jump=true`，机头会瞬间对准 `CAN` 的真实方位角（344°），不会有「先照原 225° 飞一段、再被迫画一个新的大弯」的问题。
- 8 个预设首段表：`pnpm check-routes` 与独立复跑的浏览器验收（见上）两个独立渠道得出的 `from/to/distKm/bearing` 完全一致，也与 `handoff/VOY-HKG.md` 表格一致。
- 数据真实性：本次改动没有新增/修改 `AIRPORTS`/`ROUTES` 数据，只加了 `excludeCode` 参数；`routes.ts` 文件头已有的数据来源说明（机场坐标源自维基百科机场基准点、航线是「示例性质」的现实航线网络，未逐一核对当季时刻表）保持不变，没有新增虚构机场或航线，符合仓库「数据要真实、示例数据要明确标注」的硬规矩。

### 3. 运行结果汇总

| 检查 | 结果 |
| --- | --- |
| `pnpm --filter voyage check-routes` | 通过，8 预设 + ROUTES 表 55 条无自环 |
| `handoff/VOY-HKG-check.mjs`（独立复跑，端口 5359） | 9 项 × 3 断言，27/27 `[OK]`，控制台零 error |
| `pnpm typecheck` | 通过 |
| `pnpm --filter voyage build` | 通过，`dist/assets` 0 字节文件 0 个 |
| `node apps/voyage/scripts/lint-shaders.mjs`（check:glsl） | 全部通过 |
| 与 `master`（`732fc61`）试合并 | 无冲突，仅 README 一处自动合并成功 |

## 非阻塞遗留

1. `director.ts` 的 `resumeRoute()` 里 `joinNetwork(true)`（无缓存航段分支）目前在现有调用图下不可达，见上「逐项核对 1」。建议后续要么在代码注释里标注「当前不可达，防御性保留」，要么在下一次顺手清理时移除，避免被误认成已验证路径。
2. `handoff/VOY-HKG-check.mjs` 首次切换（`scs-start.png`，t0 截图）时，页面仍在编译着色器的加载遮罩下，信息栏顶部那一行还显示上一个预设（`leg-HND-KIX`）的旧文字，但右侧面板「起点/航线」已经正确显示「当前位置 → 广州白云」。这是首次编译期间显示刷新滞后的既有截图时机问题，不是本次改动引入的缺陷；`scs-60s.png`（60 秒后）已经完全正确（`HKG → CAN`、机翼平直、正常巡航画面）。仅作记录，不需要处理。

## 复现

```
cd apps/voyage
pnpm --filter voyage exec vite --port <端口> --strictPort --host 127.0.0.1
node apps/voyage/handoff/VOY-HKG-check.mjs <端口> --out tmp/screenshot/VOY-HKG-review
pnpm --filter voyage check-routes
pnpm typecheck && pnpm --filter voyage build && find apps/voyage/dist/assets -type f -size 0
node apps/voyage/scripts/lint-shaders.mjs
```

---

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_016y6hSYV47jmqaRvVkgSr1F
