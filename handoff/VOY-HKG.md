# VOY-HKG · 南海预设首段航线是 HKG→HKG 的圈 · 交接

TW02 报告：连续航程（`voyage=1`，默认开启）选南海预设（`preset scs`）时，第一段航线起终点都是 HKG，自动驾驶
一直压 25° 坡度绕圈，窗外只有海——用户第一眼能看到的画面。本任务查根因、修在根因处，并检查了全部预设。

## 根因

`src/director.ts` 的 `joinNetwork()`（非航线预设开启连续航程时「从当前位置接入航线网」）：

```ts
const to = airportAhead(lat, lon, s.heading);      // 挑「机头前方」的机场
const here = { ...nearestAirport(lat, lon).airport }; // 挑「离当前位置最近」的机场，只当 makeLeg 的占位起点
const leg = makeLeg(here, to);
```

`airportAhead()`（`src/routes.ts`）不是按「是否真的在机头前方」硬性筛选，而是给航线网里每个机场打分 `距离 × (1 + 转角 / 45)`、取最小的：

```ts
const score = d * (1 + turn / 45);
```

航线网（`AIRPORTS` / `ROUTES`）只覆盖东亚（日本 / 韩国 / 中国大陆 / 台湾 / 香港）。南海预设（`scs`：18.0°N 115.0°E，
航向 225° 西南）朝西南飞出了这个覆盖范围——航线网里**没有一个机场真的在机头前方**。这种情况下 `airportAhead`
的打分退化成「就近选最近的那个」：香港（HKG，离预设起点约 492 km）本身既是全网最近的机场，也是这个打分公式
下分数最低的候选（转角 125° 再大也架不住距离最小）。于是 `here`（最近机场）和 `to`（机头前方机场）选到了**同一个
机场 HKG**——航段的起点和终点是同一个机场。

`joinNetwork()` 之后会把 `leg.distKm` 按当前位置重新算成真实距离（约 492 km，非零），但 `leg.bearing` 仍是
`makeLeg(HKG, HKG)`（同一个点求方位角）算出的退化值 0——一段「起终点相同、距离却非零」的自相矛盾航段。飞机随后
沿真实的 `preset.dest`（HKG 坐标）导航，要把航向从预设写死的 225° 转到 HKG 的真实方位角（约 350°），一个 125°
的大弯，`navDiff()` / `steer()` 一直压着接近最大坡度（25°）转好几十秒到两三分钟才能转完——这正是「一直压坡度、
窗外只有海」的现象。

**排查全部预设**（`src/flight.ts` 的 `PRESETS`）后确认：`yangtze`（长江中下游预设）同款中招（SHA→SHA），只是
转角恰好只有 1.2°、几乎感觉不到，没被之前的验收发现。`wpac` / `ecs` / `fuji` 因为航线网在它们的场景航向方向上
确实有别的机场，不会选到同一个机场——但 `wpac` 首段本来就要转 140°（VOY-DEFAULT 已经用「机头直接对准」修过
一次，见下）。三个「航线预设」（`hnd-cts` / `hnd-itm` / `pvg-pek`）走的是完全不同的代码路径（`preset.dest` 直接
给定，起终点是 id 里写死的两个机场代码），不受影响。

## 改动

1. **`src/routes.ts`**：`nearestAirport(lat, lon, excludeCode?)` / `airportAhead(lat, lon, headingDeg, excludeCode?)`
   都加一个可选的 `excludeCode` 参数（默认 `undefined`，不影响任何既有调用方）；`airportAhead` 的兜底分支
   （150 km 短程规则把候选全排掉时）也从「写死 `AIRPORTS.HND`」改成 `nearestAirport(lat, lon, excludeCode)`，
   同样尊重排除项。
2. **`src/director.ts` 的 `joinNetwork(jump = false)`**：
   - 先算 `here`（当前位置最近的机场），再用 `airportAhead(lat, lon, s.heading, here.code)` 排除它选 `to`——
     保证 `here !== to` 恒成立，不会再出现「起终点相同」的航段。
   - `leg.bearing` 从「`makeLeg(here, to)` 算出的机场对机场方位角」改成 `greatCircleBearing(lat, lon, to.lat, to.lon)`
     ——按当前真实位置算，和 `leg.distKm` 的口径一致（原来两者口径不一致，也是这次顺手修的一处不一致）。
   - 新增 `jump` 参数：为 `true` 时接入航线网后机头直接对准新航段（`s.heading = leg.bearing`、`s.bankDeg = 0`），
     不借自动驾驶去转——同 VOY-DEFAULT 给 `wpac` 默认预设做过的处理，这次把它从「只在页面首载生效」扩展到
     「任何一次凭空接入航线网」。三个调用方：
     - `setActive(on, jump)`：把已有的 `jump` 原样传下去（页面首载默认开启连续航程 = `true`；用户中途手动
       勾选开启 = `false`，保留「照常转、不跳」的原意）。
     - `onPresetChanged()`：换到非航线预设且连续航程已经开着时，传 `true`（换地点本来就是一次跳变，和下面
       `weather.onJump()` 同一条路）——**这才是 TW02 报告场景的直接命中路径**：用户在 `voyage=1` 已经开着的
       情况下，从面板「地点」下拉切到「南海」。
     - `resumeRoute()`：没有缓存航段、连续航程开着时，传 `true`（同样是「凭空接入航线网」，和前两条一致；
       有缓存航段时继续飞它的终点，可能要转大弯，那是用户点「回到自动航线」的指令，仍照常转、不跳）。
3. **`scripts/check-routes.mts`**（新增，`pnpm check-routes`）：离线断言，不开浏览器。检查 `ROUTES` 表没有
   自环；对 `PRESETS` 里每一个预设复现「首段」的实际选取（航线预设按 id 解 `from`/`to`，非航线预设复现
   `joinNetwork()` 的 `here`/`to`），断言起点终点不是同一个机场。新增预设或改 `airportAhead` 评分逻辑时先跑
   这个，能在不开浏览器的情况下当场抓到「起终点相同」的回归。
4. **`handoff/VOY-HKG-check.mjs`**（验收脚本）：每个预设各开一个全新浏览器上下文，`voyage=1` 载入，再用面板
   「地点」下拉切到目标预设（和用户在 UI 上操作完全一致，不直接调 `setPreset()`），60 s 内采样 `bankDeg`，
   断言首段起终点不同、60 s 内坡度回到 ≤5°、控制台零 error。`handoff/VOY-HKG-shots.mjs`：单独给 `scs` 拍
   「启动」「60 s 后」两张截图。

## 各预设首段表（`pnpm check-routes` 的实际输出，2026-09-29，RTX 5090 / d3d11）

| 预设 id | 首段 | 距离 | 方位 | 离场景航向的转角 | 备注 |
| --- | --- | --- | --- | --- | --- |
| `wpac` | 当前位置 → HND→KIX（关西） | 653 km | 320° | 140° | VOY-DEFAULT 已修：机头直接对准，不转 |
| `ecs` | 当前位置 → PVG→FUK（福冈） | 495 km | 56° | 24° | 本来就没问题 |
| `scs` | 当前位置 → HKG→CAN（广州白云） | 625 km | 344° | 119° | **本任务修：曾是 HKG→HKG** |
| `yangtze` | 当前位置 → SHA→PVG（浦东） | 594 km | 71° | 1° | **本任务修：曾是 SHA→SHA**（转角小，肉眼几乎看不出） |
| `fuji` | 当前位置 → HND→ITM（伊丹） | 321 km | 267° | 3° | 本来就没问题 |
| `hnd-cts` | HND → CTS（起讫写死） | 820 km | 11° | — | 航线预设，不走这条逻辑 |
| `hnd-itm` | HND → ITM（起讫写死） | 404 km | 259° | — | 航线预设，不走这条逻辑 |
| `pvg-pek` | PVG → PEK（起讫写死） | 1099 km | 336° | — | 航线预设，不走这条逻辑 |

「首段」列的第一个代码是 `here`（当前位置最近的机场，只当占位）、箭头后是真正的起点/终点显示（`当前位置 → 机场`）；
「离场景航向的转角」是场景写死的 `heading` 与实际目标方位角之差——这个角度在旧代码里就是「自动驾驶要压多久坡度」
的量级，现在因为 `jump=true` 时机头直接对准，实测全部预设 `bankDeg` 在 2–3 s 内收敛到 0 附近（见下）。

## 验收结果

`node apps/voyage/handoff/VOY-HKG-check.mjs 5293 --out tmp/screenshot/VOY-HKG`：9 项（8 个预设 + 面板下拉里
一个指向当前默认航段的联动项 `leg-HND-KIX`，选中它时会退回 `wpac`，属于既有行为、非本任务范围）全部通过——
每个预设切换后 `bankDeg` 都在 2.3–2.8 s 内回落到 ≤5°（实测最大坡度 0.01–0.06°，几乎没有可感知的转弯），首段
起终点均不同，控制台零 error。

```
[OK]   [scs] 首段起终点不同  {"from":"HKG","to":"CAN","distKm":625}
[OK]   [scs] 60 s 内坡度回到 ≤5°  {"recoveredAtMs":2409,"maxBankDeg":0.01,"finalBankDeg":-0.01,"leg":{"from":"HKG","to":"CAN","distKm":625}}
[OK]   [scs] 控制台零 error  []
[OK]   [yangtze] 首段起终点不同  {"from":"SHA","to":"PVG","distKm":594}
[OK]   [yangtze] 60 s 内坡度回到 ≤5°  {"recoveredAtMs":2463,"maxBankDeg":0.04,...}
```

`scs` 专门截图（`tmp/screenshot/VOY-HKG/scs-start.png` / `scs-60s.png`）：切到南海预设后机翼平直、面板显示
「航段 HKG → CAN（香港 → 广州白云，625 km），巡航，1×」，窗外是晴天积云 32%、正常的海上巡航景色，不再是
「一直转弯、窗外只有海」。

`pnpm check-routes`：全部通过（表格见上）。`pnpm typecheck`：通过。`pnpm --filter voyage build`：通过，
`find apps/voyage/dist/assets -type f -size 0` 0 个。`node scripts/lint-shaders.mjs`（`check:glsl`）：全部通过。
`node apps/voyage/scripts/dev-browser.mjs check --port 5293`：硬件渲染（RTX 5090 / d3d11），控制台零 error。

## 已知的非本任务范围

- 面板「地点」下拉里会动态插一个指向当前航段的联动项（如 `leg-HND-KIX`），但它不在 `src/flight.ts` 的
  `PRESETS` 静态表里，选中它 `setPreset()` 会 `find` 不到、回退到 `PRESETS[0]`（`wpac`）——不是本任务引入的
  行为（`src/ui.ts` 里已有的逻辑），验收脚本按「9 个下拉选项」跑了一遍，第 9 个和 `wpac` 结果重复，符合预期，
  没有额外处理。
- `resumeRoute()` 没有缓存航段这条分支现在也传 `jump=true`；有缓存航段时仍然「照常转、不跳」（这是用户点
  「回到自动航线」的显式指令，转弯本身是预期行为），没有改。

## 复现

```
pnpm --filter voyage exec vite --port 5293 --strictPort --host 127.0.0.1
node apps/voyage/handoff/VOY-HKG-check.mjs 5293 --out tmp/screenshot/VOY-HKG
node apps/voyage/handoff/VOY-HKG-shots.mjs 5293 --out tmp/screenshot/VOY-HKG
pnpm --filter voyage check-routes    # 或在 apps/voyage 目录下：pnpm check-routes
```
