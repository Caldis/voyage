# PUB-4 · 修美术总监发布审查的三条阻塞（B1 / B3 / B4）· 交接

状态：完成，待协调者核验。依据：`handoff/PUB-3b-art.md`（美术总监，2026-09-29，主仓库 master 31104a2）。

## 改了什么

### B3：奇观不挡日月（巨柱群实测，天梯 / 建木代码同理）

- `src/render/outside-pass.ts`：太阳圆盘合成的 `#ifdef` 链原来只有 `ORBIT_RING` / `VERTICAL_CONTINENT` 两支乘了
  `(1 - 覆盖)`，`#else` 分支（巨柱群 OWP、天梯 / 建木的 wonderSky 都走这里）直接加日面。加了一个
  `#elif defined(OUTSIDE_WONDER)` 分支，统一用 `gWonderCov` 扣一次；默认程序不含 `OUTSIDE_WONDER` 宏，预处理后仍落进
  最后的 `#else`，逐字不变。
- `src/wonders/pillars.glsl.ts`（第 226 行 `vec3 Lbg = L;`）与 `src/render/wonder-sky.glsl.ts`（第 551 行，
  天梯 / 建木共用）：都照 `continent.glsl.ts:298` / 天环的做法，改成
  `vec3 Lbg = L - (tLimit > 1e8 ? moonDisk(rd) * sunTransmittance(uCamR, rd.y) : vec3(0.0))`——只在真天空（没打到地面）
  时才有月盘可减。根因是这两处原来直接 `Lbg = L`，`L` 里已经加了月面（`outside-pass.ts` 第 216 行），柱子 / 塔 / 树
  覆盖不满（浮现前沿、远柱 cov < 1）时用 `mix(L, ..., 覆盖率)` 混色，月面就从背景里透出来。

验收：`handoff/PUB-3b-sun-jobs.json` 复测，`tmp/screenshot/PUB-4/sun-jobs/p3b-pillars-sun.png` 日面不再压在柱子上；
回归场景 `ws-pillars-dusk`（月夜）不再有月面贴在柱身上。`pnpm check:glsl` 全部通过（含「默认程序不含罕见光学 / 天幕层奇观代码」
的断言）；`node scripts/shader-parity.mjs --base master` 只有 6 个含 `OUTSIDE_WONDER` 的变体
（outside-continent / outside-extras / outside-ground-detail / outside-pillars / outside-rail / outside-ring）不同，
`outside-default` 逐字相同。

### B4：垂直大陆先从自动出场池拿掉

- `src/wonders/catalog.ts` 的 `vcontinent` 条目：`sunWeight` 改成 `() => 0`，原曲线注释保留在旁边（写明 WS09-b 根治后怎么改回来）。
  `WonderSystem.candidates()`（`src/wonders/system.ts`）按 `sunWeight(...) > 0` 过滤候选，权重 0 之后它永远不会被随机抽中；
  `trigger(id)`（URL、调试面板「召唤」按钮）和回归场景都直接 `wonderById(id)` 查表，不经过 `candidates()`，不受影响。
- 没有改 `wonders/continent.glsl.ts` 的着色（根治留给 WS09-b）。

验收：`handoff/PUB-4-b4-check.mjs` 在太阳高度角 −30°..30° 每 5° 扫一遍 `candidates()`，`vcontinent` 从未出现；
回归场景 `ws-vcont-noon` / `ws-vcont-dusk` / `ws-vcont-night` / `ws-vcont-sea` / `ws-vcont-backlit` / `ws-vcont-noon-up`
（都按 id 手动触发）照常渲染、0 error。

### B1：默认首屏兜底（晴空 < 15% 抬到淡积云）

- `src/weather-director.ts`：新增私有标记 `firstAlign`（页面打开后只用一次，和每次跳变都会重置的 `snapNext`不是一回事）。
  在 `sampleField` 的 `jump` 分支（连续航程首次对齐天气场，由 `director.setActive(true, true)` → `weather.onJump()` →
  `snapNext = true` 触发）里，`this.cur = pick(s)` 之后：若 `firstAlign && this.cur.coverage < 0.15`，把云量改成
  `0.25 + Math.random() * 0.15`（25%–40%）、`regime` 设成 `"cumulus"`，写一条面板日志；不用另配 `bottom / top / type /
  density`——`weather.ts` 的 `"clear"` 分支本来就带着 `bottom 1.2、top 3.4、type 1、density 1` 这组淡积云缺省值
  （`guessRegime` 的判据 `type ≥ 0.7 且 top ≤ 5 且 bottom < 4` 正好落进 cumulus），只缺云量一项。`firstAlign` 用过一次
  之后永久置 `false`，之后所有跳变（换预设、中途手动开连续航程）都不再受影响，照天气场自然演变。
- 没有找到现成的「URL 显式指定云量 / 天气」参数（全仓库搜了一遍，只有 `?fujiCap=1` 这种整段预设切换，不是单独的云量
  覆写），所以没有加额外的旁路判断；`firstAlign` 本身已经把影响面收紧到「页面打开后唯一一次」。

验收（`handoff/PUB-4-b1-check.mjs`）：在天气场里搜出一个真正判成 `clear`（coverage 0）的经纬度，直接摆好
`snapNext / firstAlign` 私有状态调 `sampleField`（和 `setActive(true, true)` 触发的是同一条路径），
第一次：`coverage 0 → 0.3636`、`regime → cumulus`、`firstAlign → false`；紧接着模拟第二次跳变（同一个 clear 点）：
`coverage` 保持 `0`、`regime` 保持 `clear`——确认只影响首次。另外用 `handoff/PUB-3b-look.mjs` 复现原报告里同一个
场景（`leg-HND-KIX`、16:50 JST）：`tmp/screenshot/PUB-3b/c/first-1600-t15.png` 面板显示「晴天积云 32%」，窗外能看到
成片的积云，不再是原报告里那种没有一朵云的光滑渐变；`first-390-t13.png`（手机竖屏）同样有云。

## 没做 / 留给后面

- B2（整流罩锯齿）、B4 的根治（垂直大陆岩壁受光重做）不在本任务范围，见 PUB-3b-art.md 建议交给 WS09-b。
- B1 是概率性问题（依赖天气场随机结果），没有办法用固定截图 100% 复现原报告的 0% 云天气；改用直接调用
  `sampleField` 的白盒验证证明了 nudge 逻辑本身正确，并另外用挂钟复放同一条航段（`leg-HND-KIX`, 16:50 JST）验证了
  实际画面确实从「一片空白」变成了「32% 积云」。

## 回归 / 验证记录

- `pnpm --filter voyage typecheck`：通过。
- `pnpm --filter voyage build`：通过；`find dist/assets -type f -size 0`：无输出（没有 0 字节文件）。
- `pnpm --filter voyage check:glsl`：全部通过。
- `node scripts/shader-parity.mjs --base master`：6 个含 `OUTSIDE_WONDER` 的奇观变体不同（B3 的预期改动），
  `outside-default` 与其余全部程序逐字相同。
- `node scripts/dev-browser.mjs shots --port 5304`（全量 59 个回归场景，不加 `--only`）：GPU 空闲（测前 `nvidia-smi`
  1%），截图期间控制台 0 error / pageerror。
- 端口 5304 的 dev server 用完按自己的 PID（88660）关闭，未按端口批量查杀。

## 涉及文件

- `apps/voyage/src/render/outside-pass.ts`（太阳圆盘 `#ifdef` 链）
- `apps/voyage/src/wonders/pillars.glsl.ts`（巨柱群 `Lbg` 扣月盘）
- `apps/voyage/src/render/wonder-sky.glsl.ts`（天梯 / 建木共用的 `Lbg` 扣月盘）
- `apps/voyage/src/wonders/catalog.ts`（垂直大陆 `sunWeight` 归零）
- `apps/voyage/src/weather-director.ts`（首屏兜底 nudge）
- `apps/voyage/handoff/PUB-4-b1-check.mjs`、`apps/voyage/handoff/PUB-4-b4-check.mjs`（本任务的白盒验证脚本，供审查复测；
  用不上时可以删）

## 开发体验反馈

- **哪里慢**：读代码定位「日面 / 月面怎么合成到 L 里」花的时间比改代码本身长——`outside-pass.ts` 里太阳圆盘的
  `#ifdef` 链和天幕层奇观的 `#ifdef` 链是两段分开写的（`OUTSIDE_WONDER` 块在 226–245 行结束，`ORBIT_RING` 的太阳圆盘
  判断在 247 行重新起了一条独立的 `#ifdef` 链），第一眼容易看漏「这条链其实覆盖了默认程序」。
- **哪里卡**：没有现成的方法从「外面」（不改代码）验证 `WeatherDirector` 这类只在特定随机条件下触发的概率性 bug；
  最后是靠 TS 的 `private` 只在编译期检查、运行期就是普通属性这个事实，直接在页面里摆状态、调私有方法测的。
  如果以后还要测这类「天气场取样結果依赖」的逻辑，值得在 `weather-director.ts` 里留一个只读的调试入口
  （比如 `__voyage.director.weather` 本来就整个对象都暴露了，倒也够用，只是不是每个人都会想到直接调私有方法）。
- **怎么绕过去的**：写了两个一次性脚本（`handoff/PUB-4-b1-check.mjs`、`handoff/PUB-4-b4-check.mjs`），
  前者直接调 `wd.sampleField(lat, lon, t)` 白盒验证 nudge，后者扫 `wonders.candidates()` 确认权重真的归零了。
  两个都不到 40 行，比截图对比更快、更确定。
- 没有遇到冷编译 / 浏览器锁排队问题（本任务全程只用自己的私有浏览器，没有和其他代理抢锁）。
