// DX-03：回归场景表的单一源。
//
// `scripts/dev-browser.mjs`（DX-01，私有 headless，真 Node 环境）直接 `import` 这个文件。
// `scripts/regression.playwright.js`（给 Playwright MCP 的 `browser_run_code_unsafe` 用）没法这样引用：
// 那个执行环境明确没有全局 `URL`、`setTimeout`（见 README 坑点），大概率是一个没有 `require`/`import` 的裸 V8
// 上下文（vm 沙箱那一类），不是完整的 Node ——贸然假设它能 `import` 这个文件、把 MCP 版脚本改坏，
// 会连累正在用共享浏览器的其他代理，风险比收益大。所以 regression.playwright.js 里保留了一份文本完全一致的
// 副本（场景数组逐字相同），并在那边的头部注明「与 scenarios.mjs 同步」。
// 改这张表时两处一起改；`applyScene` 同理（它要被 `page.evaluate(applyScene, arg)` 序列化进浏览器，
// 不能引用任何模块级闭包变量，所以 DEFAULTS 是通过参数传进去的，不是靠 import）。
//
// 场景字段：
//   name    场景名，同时是截图 / JSON 输出的文件名
//   p       面板控件 id -> 值（在 DEFAULTS 基础上覆盖）
//   offset  云的世界偏移 [x, y]（uCloudOffset），不填就是 [0, 0]
//   wait    截图前等待的毫秒数，不填是 2500
//   ground  是否要等真实地面瓦片加载（最多等 40 秒，ground.pending < 5 才继续）
//   head    头部位置：一个数字（只设 z，向后兼容旧场景）或 [x, y, z] 三元组（DX-03「headX」，
//           用来表达邻座 / 前排座位这类横向偏移，参考 T06 复核脚本的 forward-seat / own-seat 场景）
//   js      （T17）一段脚本，场景设好之后、snapAll 与截图等待之前执行，参数 v = window.__voyage；
//           用来开调试开关，例如 "v.optics.force.glory = true" 或 "v.optics.pinGreenFlash(0.5)"；
//           有返回值时附在输出 JSON 的 info 末尾（"js: …"），在截图等待之前求值
//   continuousJourney （DX-12）默认 false：连续航程（director.active）默认关闭，避免上一个场景串味到
//           下一个；场景确实想要连续航程时设 true。p 里显式给 "voyage-on" 效果相同（会覆盖这里）。
//   playRate（DX-12）默认 0：「时间流速」（state.playRate）默认关闭（同上的串味顾虑，没有对应的
//           控件 id 能走 p 那条路）；场景想要加速播放时给一个倍率（1/10/60 等，对应面板按钮的档位）。
//   p["view-preset"]（DX-12）给了且没有同时给 sc.head 时，头部位置由 ui.ts 的 setView() 决定（前 /
//           后 / 舷窗中央……），不会被下面「head 没给时用硬编码默认坐姿」这条覆盖；sc.head 仍然优先。
//
// DX-07：依赖月相 / 星空的夜景、黄昏场景全部写死 date（不写就用「打开页面当天」，月相每天都在变，
// 跨波对比会误判——第 6 波美术总监报告 ART_REVIEW_wave6.md 撞上过一次）。选日期原则：
//   - 「城市夜景」类用无月夜（月亮在地平线下，越低越保险，避免临界折射 / 大气模型误差把它顶到地平线附近）；
//   - 另留一个专门看月光的满月场景（night-sea-fullmoon）。
// 月亮高度 / 方位都用仓库自带的 astronomy-engine 算的（T09 的 moonState 同一套天文库），下面每条场景注释里的
// 数值是 `node -e` 临时脚本跑出来的（对应 preset 的 lat/lon/tz，local time = 面板 time 字段换算）。

export const DEFAULTS = {
  preset: "wpac",
  seat: "right",
  weather: "fair",
  "cloud-preset": "cumulus",
  "cabin-light": true,
  "cabin-class": "business",
  altitude: 10.7,
  shade: 0,
  wind: 7,
  "wing-pos": "8",
  "ground-on": true,
  // TR03：放在最后——火车场景的 vehicle: "train" 在换完地点 / 座位之后才生效；飞机场景跟在火车场景后面时自动切回飞机
  vehicle: "plane",
};

export const SCENES = [
  { name: "noon-cumulus", p: { preset: "wpac", time: 720, "wing-pos": "8" } },
  { name: "sunset-wing", p: { preset: "wpac", time: 1040, "wing-pos": "8" } },
  // C10c：巡航高度（10.7 km）俯看浓层积云海（覆盖 0.7）——最常见的窗外画面，云步进类任务的必测场景（C10b 审查 P2：
  // 进云首样本的受光深度把近处 0–60 km 压暗）。14:00 与 17:10（低太阳，受光随深度衰减最陡、最敏感）；日期写死只为太阳位置可复现
  { name: "sea-sc", p: { preset: "wpac", date: "2026-09-28", time: 840, "cloud-preset": "stratocumulus", coverage: 0.7, "wing-pos": "-4" } },
  { name: "sea-sc-low", p: { preset: "wpac", date: "2026-09-28", time: 1030, "cloud-preset": "stratocumulus", coverage: 0.7, "wing-pos": "-4" } },
  // C10c 审查：同一片云海加雷暴（天气程序；近雷暴的点走另一支受光）。与 sea-sc / sea-sc-low 对比，查切程序时近处云海有没有整片跳变、
  // 雷暴半径边界上有没有亮度带
  { name: "storm-sc", p: { preset: "wpac", date: "2026-09-28", time: 840, "cloud-preset": "stratocumulus", coverage: 0.7, weather: "storm", "wing-pos": "-4" } },
  { name: "storm-sc-low", p: { preset: "wpac", date: "2026-09-28", time: 1030, "cloud-preset": "stratocumulus", coverage: 0.7, weather: "storm", "wing-pos": "-4" } },
  // DX-07：wpac 17:48 本地，2026-02-16 太阳高度 −4.7°（与旧行为的「当天」量级一致，地影拱仍在合适位置），
  // 月亮高度 −19.3°（新月相位 1%，在地平线下），不会露头
  { name: "dusk-earthshadow", p: { preset: "wpac", seat: "left", date: "2026-02-16", time: 1068, "wing-pos": "-4" } },
  { name: "clouds-variety", p: { preset: "wpac", time: 900, coverage: 0.62, altitude: 5, "wing-pos": "-4" }, offset: [37, -12] },
  // T12：卷云（11.5–12.5 km），从 9 km 往上斜看：顺高空风拉长的丝缕、向一侧甩下去的马尾，半透明、透出蓝天
  // 卷云用单独的云步进变体（clouds.ts 的 marchCirrusMat），第一次选卷云时在后台编译：js 里等它编好（最多 60 s）再截图
  { name: "cirrus-noon", p: { preset: "wpac", time: 720, "cloud-preset": "cirrus", coverage: 0.5, altitude: 9, "wing-pos": "8" }, js: "for (let i = 0; i < 240 && !['ready', 'failed'].includes(v.clouds.cirrusLayerState); i++) await new Promise((r) => setTimeout(r, 250)); return 'cirrus ' + v.clouds.cirrusLayerState;" },
  // C09：逆光银边。2026-09-27 16:45（太阳高 9.3°、方位 263°），航向写死 169°（右窗朝西，太阳在窗上部），1 km 在积云底下往上看，云偏移 [0, 3] 让 2.5–5 km 外一团积云正好挡住太阳（太阳在云顶后 3–8°），四周是天
  { name: "backlit-close", p: { preset: "wpac", date: "2026-09-27", time: 1005, altitude: 1, coverage: 0.42, "wing-pos": "-4" }, offset: [0, 3], js: "v.director.setHeading(169); v.state.heading = 169; v.state.bankDeg = 0; return 'heading ' + v.state.heading;" },
  { name: "low-sea-glint", p: { preset: "wpac", time: 980, coverage: 0, altitude: 0.6, "wing-pos": "-4" } },
  // C11：云里写死云偏移（不写时飞机停在哪就量哪，同一份代码的相邻像素差能差 30 倍，INCLOUD-CHECKER.md）；[-10, -5] 是 C09 审查 8 姿态之一，云里噪声大、对改动敏感
  { name: "in-cloud", p: { preset: "wpac", time: 840, "cloud-preset": "stratocumulus", coverage: 0.95, altitude: 1.35, "wing-pos": "8" }, offset: [-10, -5], wait: 6000 },
  { name: "storm-day", p: { preset: "wpac", time: 900, coverage: 0.3, weather: "storm", "wing-pos": "-4" } },
  { name: "typhoon-eye", p: { preset: "wpac", time: 540, coverage: 0.2, weather: "typhoon-eye", "wing-pos": "-4" } },
  { name: "typhoon-bands", p: { preset: "wpac", time: 900, coverage: 0.2, weather: "typhoon-bands", "wing-pos": "-4" } },
  { name: "typhoon-outer", p: { preset: "wpac", time: 900, coverage: 0.2, altitude: 13, weather: "typhoon-outer", "wing-pos": "-4" } },
  { name: "fuji-day", p: { preset: "fuji", time: 930, altitude: 6, coverage: 0.1, "wing-pos": "-4" }, offset: [-20, 0.2], ground: true },
  // DX-07：fuji 21:00 本地，2026-01-16 月亮高度 −75.6°（新月相位 5%），全城市夜景系列都是无月夜
  { name: "night-city", p: { preset: "fuji", date: "2026-01-16", time: 1260, altitude: 4, coverage: 0.15, "cabin-light": false }, offset: [0, -25], ground: true, head: -0.25 },
  { name: "night-city-on", p: { preset: "fuji", date: "2026-01-16", time: 1260, altitude: 4, coverage: 0.15, "cabin-light": true }, offset: [0, -25], ground: true, head: -0.25 },
  { name: "night-city-off", p: { preset: "fuji", date: "2026-01-16", time: 1260, altitude: 4, coverage: 0.15, "cabin-light": "off" }, offset: [0, -25], ground: true, head: -0.25 },
  { name: "route-hnd-cts", p: { preset: "hnd-cts", time: 990, coverage: 0.25, "wing-pos": "8" }, ground: true },
  // DX-07：hnd-cts 21:30 本地，同一个 2026-01-16 月亮高度 −80.4°，同样是无月夜
  { name: "route-hnd-cts-night", p: { preset: "hnd-cts", date: "2026-01-16", time: 1290, coverage: 0.1, seat: "left", "cabin-light": false, "wing-pos": "8" }, ground: true },
  // G08c：瓦片竖缝回归。fuji 原点以西 111.74 km（约 35.0°N、137.72°E 的山地）、1.2 km 低空：这里正好压着一条 z12 地形瓦片边，
  // 旧矩形在高度图 L0–L5 每级留一条 0 m 竖缝（L0 约 125 m 宽，两侧 590–740 m），heightAt 在缝上返回 0。日期写死只为太阳位置可复现
  { name: "fuji-west-seam-low", p: { preset: "fuji", date: "2026-01-16", time: 720, altitude: 1.2, coverage: 0, "wing-pos": "-4" }, offset: [-111.74, 0], ground: true },
  // G08c：1 km 低空夜城、原点以西 97 km（约 36.2°N、139.22°E，按经纬度推算在埼玉县本庄市附近的平原），正压着 z8 夜光瓦片边 139.21875°E：
  // 旧矩形在夜光 L0 留约 1.4 km 宽的无灯带。无月夜（hnd-cts 21:30、2026-01-16，月亮 −80.4°，同 route-hnd-cts-night）
  { name: "night-city-low-west", p: { preset: "hnd-cts", date: "2026-01-16", time: 1290, altitude: 1, coverage: 0.1, seat: "left", "cabin-light": false, "wing-pos": "8" }, offset: [-97, 0], ground: true },
  { name: "economy-ahead", p: { preset: "wpac", time: 720, "wing-pos": "8", "cabin-class": "economy" }, head: [-0.42, 0.1, -0.5] },
  // T09：夜间无月（2026-05-15 22:30，残月在地平线下 53°）、关舱灯（全关）、南海上空、左座朝东南：人马座大星云低低地在窗正中
  { name: "night-sea-milkyway", p: { preset: "scs", seat: "left", date: "2026-05-15", time: 1350, coverage: 0.15, "cabin-light": "off", "wing-pos": "-4" } },
  // DX-07：专看月光的满月场景。scs 22:30 本地，2026-04-01 月亮相位 99.7%（近满月）、高度 58°、方位 133.8°，
  // 几乎正对左座窗外方位（heading 225 − 90 = 135°），月亮应该稳稳地挂在窗正中
  { name: "night-sea-fullmoon", p: { preset: "scs", seat: "left", date: "2026-04-01", time: 1350, coverage: 0.15, "cabin-light": "off", "wing-pos": "-4" } },
  // W01b / WS01：奇观（天幕层，js 召唤：放在窗口正对方向、直接显形；召唤前等两帧，让奇观系统拿到新的座位 / 航向）。
  // WS01 起天梯在 200–260 km（锚塔 + 环形站），尺寸按种子随机：截图写死 seed。
  // 天梯：左座朝东、日落后约 20 分钟（太阳约 −6.5°），塔与下段已入地影，高处的环站与缆仍被阳光照亮，缆上红色障碍灯同步慢闪
  { name: "wonder-tether-dusk", p: { preset: "wpac", seat: "left", date: "2026-09-27", time: 1078, coverage: 0.3, "cabin-light": false, "wing-pos": "-4" }, js: "v.wonders.enabled = true; for (let i = 0; i < 2; i++) await new Promise((r) => requestAnimationFrame(r)); v.wonders.trigger(\"tether\", { forwardOffsetDeg: 0, distKm: 220, reveal: 1, seed: 0.37 }); return v.wonders.describe();" },
  // WS01：天梯的尺度对照（研究 WONDER_SCALE.md 的机位）：正午 / 黄昏 / 夜各「平视」「压低头仰看」两个机位，外加一张浓云海（塔脚被近处的云海挡住）
  { name: "ws-tether-noon", p: { preset: "wpac", seat: "left", date: "2026-09-27", time: 780, "cabin-light": false, "wing-pos": "-4" }, head: [0, 0.02, -0.3], js: "v.wonders.enabled = true; for (let i = 0; i < 2; i++) await new Promise((r) => requestAnimationFrame(r)); v.wonders.trigger(\"tether\", { forwardOffsetDeg: 0, distKm: 220, reveal: 1, seed: 0.37 }); return v.wonders.describe();" },
  { name: "ws-tether-noon-up", p: { preset: "wpac", seat: "left", date: "2026-09-27", time: 780, "cabin-light": false, "wing-pos": "-4" }, head: [0, -0.12, -0.3], js: "v.wonders.enabled = true; for (let i = 0; i < 2; i++) await new Promise((r) => requestAnimationFrame(r)); v.wonders.trigger(\"tether\", { forwardOffsetDeg: 0, distKm: 220, reveal: 1, seed: 0.37 }); return v.wonders.describe();" },
  { name: "ws-tether-dusk-up", p: { preset: "wpac", seat: "left", date: "2026-09-27", time: 1070, coverage: 0.3, "cabin-light": false, "wing-pos": "-4" }, head: [0, -0.12, -0.3], js: "v.wonders.enabled = true; for (let i = 0; i < 2; i++) await new Promise((r) => requestAnimationFrame(r)); v.wonders.trigger(\"tether\", { forwardOffsetDeg: 0, distKm: 250, reveal: 1, seed: 0.83 }); return v.wonders.describe();" },
  { name: "ws-tether-night", p: { preset: "wpac", seat: "left", date: "2026-09-27", time: 1320, "cabin-light": false, "wing-pos": "-4" }, head: [0, 0.02, -0.3], js: "v.wonders.enabled = true; for (let i = 0; i < 2; i++) await new Promise((r) => requestAnimationFrame(r)); v.wonders.trigger(\"tether\", { forwardOffsetDeg: 0, distKm: 220, reveal: 1, seed: 0.37 }); return v.wonders.describe();" },
  { name: "ws-tether-night-up", p: { preset: "wpac", seat: "left", date: "2026-09-27", time: 1320, "cabin-light": false, "wing-pos": "-4" }, head: [0, -0.12, -0.3], js: "v.wonders.enabled = true; for (let i = 0; i < 2; i++) await new Promise((r) => requestAnimationFrame(r)); v.wonders.trigger(\"tether\", { forwardOffsetDeg: 0, distKm: 220, reveal: 1, seed: 0.37 }); return v.wonders.describe();" },
  { name: "ws-tether-sea", p: { preset: "wpac", seat: "left", date: "2026-09-27", time: 960, "cloud-preset": "stratocumulus", coverage: 0.6, "cabin-light": false, "wing-pos": "-4" }, head: [0, 0.02, -0.3], js: "v.wonders.enabled = true; for (let i = 0; i < 2; i++) await new Promise((r) => requestAnimationFrame(r)); v.wonders.trigger(\"tether\", { forwardOffsetDeg: 0, distKm: 230, reveal: 1, seed: 0.37 }); return v.wonders.describe();" },
  // 建木，白天（下午）：缠着树干旋上去的云气是白天最先被注意到的东西，九欘（弯枝）在窗里的高处
  { name: "wonder-jianmu-day", p: { preset: "wpac", date: "2026-09-27", time: 900, coverage: 0.3, "wing-pos": "-4" }, js: "v.wonders.enabled = true; for (let i = 0; i < 2; i++) await new Promise((r) => requestAnimationFrame(r)); v.wonders.trigger(\"jianmu\", { forwardOffsetDeg: 0, distKm: 230, reveal: 1, seed: 0.37 }); return v.wonders.describe();" },
  { name: "ws-jianmu-dusk", p: { preset: "wpac", seat: "left", date: "2026-09-27", time: 1070, coverage: 0.3, "cabin-light": false, "wing-pos": "-4" }, head: [0, 0.02, -0.3], js: "v.wonders.enabled = true; for (let i = 0; i < 2; i++) await new Promise((r) => requestAnimationFrame(r)); v.wonders.trigger(\"jianmu\", { forwardOffsetDeg: 0, distKm: 230, reveal: 1, seed: 0.37 }); return v.wonders.describe();" },
  { name: "ws-jianmu-dusk-up", p: { preset: "wpac", seat: "left", date: "2026-09-27", time: 1070, coverage: 0.3, "cabin-light": false, "wing-pos": "-4" }, head: [0, -0.12, -0.3], js: "v.wonders.enabled = true; for (let i = 0; i < 2; i++) await new Promise((r) => requestAnimationFrame(r)); v.wonders.trigger(\"jianmu\", { forwardOffsetDeg: 0, distKm: 230, reveal: 1, seed: 0.37 }); return v.wonders.describe();" },
  // WS07：巨柱群（天幕层，锚点 190–200 km 正对窗口，种子写死：0.83 是 9 根方柱、主柱 69 km 在默认头位出画；0.42 是 9 根圆柱）：正午平视 / 仰看（整群）、黄昏（柱脚入夜、柱顶还被照着）、夜（柱顶红灯同步慢闪、环带灯）、浓云海（柱脚被近处的云海吞没）
  { name: "ws-pillars-noon", p: { preset: "wpac", seat: "left", date: "2026-09-27", time: 780, "cabin-light": false, "wing-pos": "-4" }, head: [0, 0.02, -0.3], js: "v.wonders.enabled = true; for (let i = 0; i < 2; i++) await new Promise((r) => requestAnimationFrame(r)); v.wonders.trigger(\"pillars\", { forwardOffsetDeg: 0, distKm: 190, reveal: 1, seed: 0.83 }); return v.wonders.describe();" },
  { name: "ws-pillars-noon-up", p: { preset: "wpac", seat: "left", date: "2026-09-27", time: 780, "cabin-light": false, "wing-pos": "-4" }, head: [0, -0.12, -0.3], js: "v.wonders.enabled = true; for (let i = 0; i < 2; i++) await new Promise((r) => requestAnimationFrame(r)); v.wonders.trigger(\"pillars\", { forwardOffsetDeg: 0, distKm: 190, reveal: 1, seed: 0.83 }); return v.wonders.describe();" },
  { name: "ws-pillars-dusk", p: { preset: "wpac", seat: "left", date: "2026-09-27", time: 1068, coverage: 0.3, "cabin-light": false, "wing-pos": "-4" }, head: [0, 0.02, -0.3], js: "v.wonders.enabled = true; for (let i = 0; i < 2; i++) await new Promise((r) => requestAnimationFrame(r)); v.wonders.trigger(\"pillars\", { forwardOffsetDeg: 0, distKm: 190, reveal: 1, seed: 0.83 }); return v.wonders.describe();" },
  { name: "ws-pillars-night", p: { preset: "wpac", seat: "left", date: "2026-09-27", time: 1320, "cabin-light": false, "wing-pos": "-4" }, head: [0, 0.02, -0.3], js: "v.wonders.enabled = true; for (let i = 0; i < 2; i++) await new Promise((r) => requestAnimationFrame(r)); v.wonders.trigger(\"pillars\", { forwardOffsetDeg: 0, distKm: 190, reveal: 1, seed: 0.83 }); return v.wonders.describe();" },
  { name: "ws-pillars-sea", p: { preset: "wpac", seat: "left", date: "2026-09-27", time: 960, "cloud-preset": "stratocumulus", coverage: 0.6, "cabin-light": false, "wing-pos": "-4" }, head: [0, 0.02, -0.3], js: "v.wonders.enabled = true; for (let i = 0; i < 2; i++) await new Promise((r) => requestAnimationFrame(r)); v.wonders.trigger(\"pillars\", { forwardOffsetDeg: 0, distKm: 200, reveal: 1, seed: 0.42 }); return v.wonders.describe();" },
  // WS09 垂直大陆（天幕层，OWV 变体按需编译）：近端的船首在窗口正对方向 230 km 外，种子写死；正午平视 / 仰看、黄昏（只剩顶沿被照亮）、夜（挡住星空的剪影）、浓云海（脚被云海吞没）
  { name: "ws-vcont-noon", p: { preset: "wpac", seat: "left", date: "2026-09-27", time: 780, "cabin-light": false, "wing-pos": "-4" }, head: [0, 0.02, -0.3], js: "v.wonders.enabled = true; for (let i = 0; i < 2; i++) await new Promise((r) => requestAnimationFrame(r)); v.wonders.trigger(\"vcontinent\", { forwardOffsetDeg: 0, distKm: 230, reveal: 1, seed: 0.83 }); return v.wonders.describe();" },
  { name: "ws-vcont-noon-up", p: { preset: "wpac", seat: "left", date: "2026-09-27", time: 780, "cabin-light": false, "wing-pos": "-4" }, head: [0, -0.12, -0.3], js: "v.wonders.enabled = true; for (let i = 0; i < 2; i++) await new Promise((r) => requestAnimationFrame(r)); v.wonders.trigger(\"vcontinent\", { forwardOffsetDeg: 0, distKm: 230, reveal: 1, seed: 0.83 }); return v.wonders.describe();" },
  { name: "ws-vcont-dusk", p: { preset: "wpac", seat: "left", date: "2026-09-27", time: 1066, coverage: 0.3, "cabin-light": false, "wing-pos": "-4" }, head: [0, 0.02, -0.3], js: "v.wonders.enabled = true; for (let i = 0; i < 2; i++) await new Promise((r) => requestAnimationFrame(r)); v.wonders.trigger(\"vcontinent\", { forwardOffsetDeg: 0, distKm: 230, reveal: 1, seed: 0.83 }); return v.wonders.describe();" },
  { name: "ws-vcont-night", p: { preset: "wpac", seat: "left", date: "2026-09-27", time: 1320, "cabin-light": false, "wing-pos": "-4" }, head: [0, 0.02, -0.3], js: "v.wonders.enabled = true; for (let i = 0; i < 2; i++) await new Promise((r) => requestAnimationFrame(r)); v.wonders.trigger(\"vcontinent\", { forwardOffsetDeg: 0, distKm: 230, reveal: 1, seed: 0.83 }); return v.wonders.describe();" },
  { name: "ws-vcont-sea", p: { preset: "wpac", seat: "left", date: "2026-09-27", time: 960, "cloud-preset": "stratocumulus", coverage: 0.6, "cabin-light": false, "wing-pos": "-4" }, head: [0, 0.02, -0.3], js: "v.wonders.enabled = true; for (let i = 0; i < 2; i++) await new Promise((r) => requestAnimationFrame(r)); v.wonders.trigger(\"vcontinent\", { forwardOffsetDeg: 0, distKm: 230, reveal: 1, seed: 0.61 }); return v.wonders.describe();" },
  // WS09 返工：逆光（航向钉 0°、左座朝西，太阳 3.9° 正落在岩壁后面）：整块大陆是有空气透视层次的暗剪影，挡住太阳
  { name: "ws-vcont-backlit", p: { preset: "wpac", seat: "left", date: "2026-09-27", time: 1030, coverage: 0.3, "cabin-light": false, "wing-pos": "-4" }, head: [0, 0.02, -0.3], js: "v.director.setHeading(0); v.state.heading = 0; v.state.bankDeg = 0; for (let i = 0; i < 10; i++) await new Promise((r) => requestAnimationFrame(r)); v.wonders.enabled = true; v.wonders.trigger(\"vcontinent\", { forwardOffsetDeg: 0, distKm: 230, reveal: 1, seed: 0.61 }); for (let i = 0; i < 6; i++) await new Promise((r) => requestAnimationFrame(r)); for (let i = 0; i < 480 && v.groundDetail.pending; i++) await new Promise((r) => setTimeout(r, 250)); for (let i = 0; i < 30; i++) await new Promise((r) => requestAnimationFrame(r)); const s = v.groundDetail.variantStatus; return v.wonders.describe() + ' ' + s.wanted + '/' + s.shown;" },
  // WS08 天环（轨道环）：正午横贯、黄昏地影切断（斜贯仰看）、新月夜的城市灯带；天环在 OWT 变体里（按需编译，截图前等 groundDetail.pending）
  { name: "ws08-noon", p: { preset: "wpac", seat: "left", date: "2026-09-27", time: 780, "cabin-light": false, "wing-pos": "-4" }, head: [0, 0.02, -0.3], js: "v.wonders.enabled = true; for (let i = 0; i < 2; i++) await new Promise((r) => requestAnimationFrame(r)); v.wonders.trigger(\"orbital-ring\", { forwardOffsetDeg: 0, distKm: 1000, reveal: 1, seed: 0.37 }); return v.wonders.describe();" },
  { name: "ws08-dusk-up", p: { preset: "wpac", seat: "left", date: "2026-09-27", time: 1090, coverage: 0.3, "cabin-light": false, "wing-pos": "-4" }, head: [0, -0.12, -0.3], js: "v.wonders.enabled = true; for (let i = 0; i < 2; i++) await new Promise((r) => requestAnimationFrame(r)); v.wonders.trigger(\"orbital-ring\", { forwardOffsetDeg: 0, distKm: 1000, reveal: 1, seed: 0.61 }); return v.wonders.describe();" },
  { name: "ws08-night-nm-up", p: { preset: "wpac", seat: "left", date: "2026-10-10", time: 1320, coverage: 0.3, "cabin-light": false, "wing-pos": "-4" }, head: [0, -0.06, -0.3], js: "v.wonders.enabled = true; for (let i = 0; i < 2; i++) await new Promise((r) => requestAnimationFrame(r)); v.wonders.trigger(\"orbital-ring\", { forwardOffsetDeg: 0, distKm: 1000, reveal: 1, seed: 0.61 }); return v.wonders.describe();" },
  // W02：雾海灯城（云间层，js 召唤，种子写死 0.37 让画面可复现；召唤后等云间层变体后台编好再截图）。
  // wpac 22:00 本地、2026-01-16 无月夜（月亮 −88°、太阳 −64°），右座朝西，城心在 95 km 外正对窗口：
  // 被灯海染橙的雾、雾里的阶梯金字塔剪影、火炬、探照光束、雾下的车流灯带
  { name: "wonder-fogcity-night", p: { preset: "wpac", date: "2026-01-16", time: 1320, coverage: 0.15, "cabin-light": false, "wing-pos": "-4" }, wait: 4000, js: "v.wonders.enabled = true; for (let i = 0; i < 2; i++) await new Promise((r) => requestAnimationFrame(r)); v.wonders.trigger(\"fogcity\", { forwardOffsetDeg: 0, distKm: 95, reveal: 1, seed: 0.37 }); for (let i = 0; i < 240 && v.clouds.wonderLayerState !== \"ready\"; i++) await new Promise((r) => setTimeout(r, 250)); return v.wonders.describe() + \" · \" + v.clouds.wonderLayerState;" },
  // W03：浮空古城（致敬《天空之城》，云间层，js 召唤，种子写死 0.23；召唤后等云间层变体编好再截图）。城心 80 km、正对窗口，层积云云海 0.6。
  // day：右座朝西、16:15（2026-09-27 太阳高 16°、方位 259°，在城左上方约 11°）：侧逆光，墨绿树冠 + 层层台地的剪影、树冠边缘透光、底座下的云团被照亮、垂根
  { name: "wonder-floatcity-day", p: { preset: "wpac", seat: "right", date: "2026-09-27", time: 975, "cloud-preset": "stratocumulus", coverage: 0.6, "wing-pos": "-4" }, wait: 4000, js: "v.wonders.enabled = true; for (let i = 0; i < 2; i++) await new Promise((r) => requestAnimationFrame(r)); v.wonders.trigger(\"floatcity\", { forwardOffsetDeg: 0, distKm: 110, reveal: 1, seed: 0.23 }); for (let i = 0; i < 240 && v.clouds.wonderLayerState !== \"ready\"; i++) await new Promise((r) => setTimeout(r, 250)); return v.wonders.describe() + \" · \" + v.clouds.wonderLayerState;" },
  // dusk：左座朝东、17:20（太阳约 1°，在身后）：台地与树冠被低日镀成暖色，身后是暗下去的东天
  { name: "wonder-floatcity-dusk", p: { preset: "wpac", seat: "left", date: "2026-09-27", time: 1040, "cloud-preset": "stratocumulus", coverage: 0.6, "cabin-light": false, "wing-pos": "-4" }, wait: 4000, js: "v.wonders.enabled = true; for (let i = 0; i < 2; i++) await new Promise((r) => requestAnimationFrame(r)); v.wonders.trigger(\"floatcity\", { forwardOffsetDeg: 0, distKm: 110, reveal: 1, seed: 0.23 }); for (let i = 0; i < 240 && v.clouds.wonderLayerState !== \"ready\"; i++) await new Promise((r) => setTimeout(r, 250)); return v.wonders.describe() + \" · \" + v.clouds.wonderLayerState;" },
  // TR03：火车模式（JR 大糸线，示例）的远景。vehicle 放在 DEFAULTS 最后，火车场景在换完地点 / 座位之后才进入火车；
  // js 等线路数据加载完、把列车放到指定里程（初速 0，截图等待期间只走一两米）、等地面瓦片和火车变体编好，再放一次。
  // default：12.65 km 豊科过后的平原段，往信濃大町、左座朝西（北阿尔卑斯）；curve：1.79 km 松本出发后的弯道（近处有女鳥羽川 / 奈良井川）
  { name: "rail-oito-default", p: { vehicle: "train", date: "2026-08-05", time: 720 }, wait: 3000, js: "for (let i = 0; i < 300 && !v.rail.active; i++) await new Promise((r) => setTimeout(r, 100)); v.rail.teleport(12650, 1, 0); for (let i = 0; i < 90 && v.ground.pending > 0; i++) await new Promise((r) => setTimeout(r, 500)); for (let i = 0; i < 480 && ![\"ready\", \"failed\"].includes(v.groundDetail.railStatus ?? v.groundDetail.status); i++) await new Promise((r) => setTimeout(r, 250)); v.rail.teleport(12650, 1, 0); return v.rail.describe() + \" · \" + (v.groundDetail.railStatus ?? v.groundDetail.status);" },
  { name: "rail-oito-curve", p: { vehicle: "train", date: "2026-08-05", time: 720 }, wait: 3000, js: "for (let i = 0; i < 300 && !v.rail.active; i++) await new Promise((r) => setTimeout(r, 100)); v.rail.teleport(1790, 1, 0); for (let i = 0; i < 90 && v.ground.pending > 0; i++) await new Promise((r) => setTimeout(r, 500)); for (let i = 0; i < 480 && ![\"ready\", \"failed\"].includes(v.groundDetail.railStatus ?? v.groundDetail.status); i++) await new Promise((r) => setTimeout(r, 250)); v.rail.teleport(1790, 1, 0); return v.rail.describe() + \" · \" + (v.groundDetail.railStatus ?? v.groundDetail.status);" },
  // SPEC-BOW：巡航高度看下方阵雨上的虹（演示雨区摆在对日点外 46°，主虹横穿窗的下半部，红在外）、贴窗看云海上的宝光 + 云虹（宝光在左下、
  // 云虹是右侧一道宽而淡的白带）、卷云里的环地平弧（太阳 62°，窗上沿一道与地平线平行的彩带，红在上）。wpac 2026-06-21 的时刻按窗朝向挑的；
  // 放在表尾：场景开了 optics.force.bow（演示雨区），别串到后面的场景里
  { name: "bow-rain", p: { preset: "wpac", date: "2026-06-21", time: 560, seat: "right", "cloud-preset": "towering", coverage: 0.3, "wing-pos": "-4" }, js: "v.optics.disabled = false; v.optics.force = { bow: true }; v.optics.resetBowDemo(); await new Promise((r) => setTimeout(r, 300)); return JSON.stringify(v.optics.status.rain);" },
  { name: "bow-cloud", p: { preset: "wpac", date: "2026-06-21", time: 360, seat: "right", "cloud-preset": "stratocumulus", coverage: 0.85, "view-preset": "close", "wing-pos": "-4" }, js: "v.optics.disabled = false; v.optics.force = { bow: true }; v.optics.resetBowDemo(); await new Promise((r) => setTimeout(r, 300)); return String(v.optics.status.cloudBow);" },
  { name: "bow-cha", p: { preset: "wpac", date: "2026-06-21", time: 824, seat: "right", "cloud-preset": "cirrus", coverage: 0.9, "wing-pos": "-4" }, js: "v.optics.disabled = false; v.optics.force = { bow: true }; await new Promise((r) => setTimeout(r, 300)); return String(v.optics.status.cha);" },
];

/**
 * 在浏览器里应用一个场景（用法：`page.evaluate(applyScene, { sc, defaults: DEFAULTS })`）。
 * 必须是纯函数：page.evaluate 只序列化函数自身的源码，任何外部闭包变量（包括本文件里的 DEFAULTS）
 * 到了浏览器那边都不存在，所以 defaults 通过参数传入，不是靠模块顶层的引用。
 *
 * DX-10（性能工程师第 6 波复测反馈，research/PERF_REPORT_wave6.md 末尾「开发体验反馈」第 5 条）：
 * 跨版本对照（例如拿老版本主分支当 `--baseline`）时，老页面可能缺这次场景表用到的控件或下拉选项
 * （例如老版本没有 `cabin-class`），原来 `set()` 直接 `el.type` 会因为 `el` 是 null 而抛错，整个 `applyScene`
 * 中断、后面的场景全部测不了。现在缺控件 / 选项只打印警告并跳过这一项，不中断整个场景；`sc.js` 执行失败也只
 * 记录失败原因、不抛出，同一份场景表因此可以在新旧版本之间共用做对照，不用像性能工程师当天那样现场写一份容错副本
 * （`tmp/perf-w6/w6_patch_scen.py`，随一次性 worktree 删掉了，没有进仓库）。
 */
export async function applyScene(arg) {
  const { sc, defaults, settle } = arg;
  const v = window.__voyage;
  document.getElementById("panel")?.classList.add("hidden");
  // DX-12：默认关闭连续航程（director.active）与「时间流速」（state.playRate），避免上一个场景串味到
  // 下一个——批量截图时如果上一个场景开着连续航程 / 时间加速，下一个场景在等地面瓦片 / 变体编译的这几秒
  // 到几十秒里飞机会继续跑、天也会继续暗，「同一机位」就对不上了（DX-12 任务背景：批量截图时飞机一直在飞）。
  // 两者都不是「按 id 设面板控件」这条路能表达的完整状态（director 没有对应的下拉框；playRate 由一组
  // [data-rate] 按钮控制，没有单一 id），所以在这里单独处理，放在下面的 p 循环之前——场景想要连续航程 /
  // 加速播放的话，用 sc.continuousJourney=true / sc.playRate=<倍率>（和 sc.head / sc.offset 同一类写法），
  // 或者在 p 里给 "voyage-on"（有真实控件 id，走 set() 那条路一样能打开，且在这之后执行，会覆盖这里的默认关闭）。
  if (v.director && typeof v.director.setActive === "function") v.director.setActive(sc.continuousJourney === true);
  if (v.state) v.state.playRate = typeof sc.playRate === "number" ? sc.playRate : 0;
  const set = (id, val) => {
    const el = document.getElementById(id);
    if (!el) {
      console.warn(`[applyScene] 页面没有控件 #${id}（老版本页面缺这个控件？），跳过`);
      return;
    }
    if (el.tagName === "SELECT" && ![...el.options].some((o) => o.value === String(val))) {
      console.warn(`[applyScene] #${id} 没有选项 "${val}"（老版本页面缺这个选项？），跳过`);
      return;
    }
    if (el.type === "checkbox") {
      el.checked = val;
      el.dispatchEvent(new Event("change"));
    } else {
      el.value = String(val);
      // 日期框只响应 change（ui.ts）
      el.dispatchEvent(new Event(el.tagName === "SELECT" || el.type === "date" ? "change" : "input"));
    }
  };
  // TR03：页面打开时的日期要在设任何场景之前记下（原来在设完场景之后才记，第一个场景写了 date 时记下的就是那一天，后面没写 date 的场景都被带过去）
  window.__voyageInitialDate ??= document.getElementById("date")?.value;
  for (const [id, val] of Object.entries({ ...defaults, ...sc.p })) set(id, val);
  if (sc.p.coverage === undefined) set("coverage", 0.42);
  // 日期（T09）：场景没写 date 时恢复成页面打开时的日期，免得上一个写了 date 的场景把后面的场景也带到那一天
  // （DX-10：老版本页面可能连 #date 控件都没有，可选链 + 判空防止整段中断）
  if (sc.p.date === undefined && window.__voyageInitialDate !== undefined) set("date", window.__voyageInitialDate);
  if (sc.p.time !== undefined) set("time", sc.p.time);
  // 上一个场景留下的状态也要清掉（例如穿云后的窗上水痕、颠簸）
  v.state.wetness = 0;
  v.state.turbulence = 0.03;
  // head：数字只设 z（向后兼容），[x,y,z] 三元组可以额外表达横向座位偏移（DX-03 headX）。
  // DX-12：场景带了 p["view-preset"] 且没有显式给 sc.head 时，不要用下面这段硬编码默认值覆盖——
  // set("view-preset", ...) 在上面的 p 循环里已经触发过 ui.ts 的 setView()，那边自己会把头部摆到这个
  // 视角预设该在的位置（前 / 后 / 舷窗中央……），这里再无条件 Object.assign 会把它覆盖回硬编码的默认坐姿。
  // sc.head 仍然优先：显式给了就按显式的来（即使同时给了 view-preset）。
  const viewPresetGiven = sc.p && sc.p["view-preset"] !== undefined;
  if (sc.head !== undefined || !viewPresetGiven) {
    let hx = 0;
    let hy = 0.02;
    let hz = -0.3;
    if (Array.isArray(sc.head)) {
      hx = sc.head[0] ?? 0;
      hy = sc.head[1] ?? 0.02;
      hz = sc.head[2] ?? -0.3;
    } else if (typeof sc.head === "number") {
      hz = sc.head;
    }
    Object.assign(v.head, { tx: hx, ty: hy, x: hx, y: hy, tz: hz, z: hz });
  }
  // 天气要在位移设好之后重新摆放
  if (sc.p.weather) set("weather", sc.p.weather);
  // settle（DX-08，配合 __voyage.freeze 做逐像素对比）：等 ground.pending 真正归零，不是原来的「< 5 且已经等过 5 轮」
  // ——瓦片还在陆续贴上来时冻结两帧、相减，差异会被当成回归。没传 settle 时行为和以前完全一样。
  if (sc.ground || settle) {
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const done = settle ? v.ground.pending === 0 : v.ground.pending < 5 && i > 5;
      if (done) break;
    }
  }
  // 奇观（W01b）：每个场景都从「没有奇观」出发（要奇观的场景在 js 里召唤），免得上一个场景的奇观带到下一个
  if (v.wonders) {
    v.wonders.clear();
    v.wonders.enabled = false;
  }
  // 舱等（T25）：没编过的变体在后台编译，画面切过去之前不截图（最多等 120 s）
  const wantClass = sc.p["cabin-class"] ?? "business";
  for (let i = 0; i < 480 && v.cabinClass && v.cabinClass.shown !== wantClass; i++) await new Promise((r) => setTimeout(r, 250));
  // DX-10：js 失败只记录失败原因，不抛出——否则一个场景的 js 写错（或老版本页面没有这个调试句柄）会中断
  // 整批场景，跨版本 / 跨提交批量对照时尤其容易撞上（PERF_REPORT_wave6.md 末尾开发体验反馈第 5 条）。
  let jsOut;
  if (sc.js) {
    try {
      jsOut = await new (async () => {}).constructor("v", sc.js)(v);
    } catch (err) {
      jsOut = `js 失败：${err && err.message ? err.message : String(err)}`;
      console.warn(`[applyScene] 场景 "${sc.name}" 的 js 执行失败，已跳过（不中断整批场景）：${jsOut}`);
    }
  }
  // 云步进变体（PERF-10）：雷暴 / 台风 / 卷云 / 奇观及其组合第一次需要时在后台编译，编好之前画的是替代的变体（天气系统暂时不画）；
  // 等它编好再截图（最多 120 s；老版本没有 cloudVariantPending 就不等）。放在 js 之后：奇观是在 js 里召唤的
  for (let i = 0; i < 480 && v.clouds && v.clouds.cloudVariantPending; i++) await new Promise((r) => setTimeout(r, 250));
  // 窗外变体（PERF-13）：罕见光学 / 天幕层奇观第一次需要时在后台编译，编好之前这些效果不画。先让主循环跑两帧、按新场景选出想要的变体，
  // 再等它编好（最多 120 s；老版本没有 pending 就不等）
  for (let i = 0; i < 2; i++) await new Promise((r) => requestAnimationFrame(r));
  for (let i = 0; i < 480 && v.groundDetail && v.groundDetail.pending; i++) await new Promise((r) => setTimeout(r, 250));
  // DX-12（PERF-10 反馈）：云的世界偏移放在这里最后再摆一次，而不是更早——上面这些变体（云 + 窗外）
  // 编译期间（最长各 120 s）如果偏移已经摆好，云本身没有被冻结，一直在按 dt 正常演化，编译完真正截图时
  // 云已经跑到别的位置去了，「同一份场景」的云看起来会和没等编译的版本不一样。放在这里（所有变体都等完、
  // wait 之前的最后一步）才是「编好了再摆」。
  if (sc.offset) v.cloudUniforms.uCloudOffset.value.set(sc.offset[0], sc.offset[1]);
  v.snapAll();
  await new Promise((r) => setTimeout(r, sc.wait ?? 2500));
  const info = document.getElementById("info")?.textContent ?? "";
  return jsOut === undefined ? info : `${info}
js: ${typeof jsOut === "string" ? jsOut : JSON.stringify(jsOut)}`;
}

/** 按名字过滤场景表；only 为空 / null 时返回全部 */
export function pickScenes(only) {
  if (!only || only.length === 0) return SCENES;
  // DX-23：未知场景名直接报错（以前静默过滤，`passes.mjs --only 拼错名` 会一个场景都不测、只打印空表）
  const known = new Set(SCENES.map((s) => s.name));
  const unknown = only.filter((n) => !known.has(n));
  if (unknown.length) throw new Error(`--only 里有未知场景：${unknown.join(", ")}\n已知场景：${[...known].join(", ")}`);
  const set = new Set(only);
  return SCENES.filter((s) => set.has(s.name));
}

/**
 * DX-12：单独把「把头部 / 云偏移钉回场景该有的值」这一步抽出来，逻辑和 applyScene 里的对应部分一致
 * （必须是纯函数、不能引用 applyScene——page.evaluate 只序列化函数自身源码，见文件头注释，所以这里是
 * 有意的小段重复，不是漏改）。给 dev-browser.mjs 的 `shots --pair`/`--ab` 用：批量截图时，从
 * applyScene 设好场景到真正冻结截图之间可能隔着等地面瓦片 / 舱等 / 云变体编译好几十秒，模拟没有冻结，
 * 飞机 / 云一直在按真实节奏往前走——冻结前用这个函数把头部与云偏移重新钉回场景 JSON 写的值，两张 A/B
 * 截图才能确保真的是「同一机位」，不受等待耗时长短影响（DX-12 任务背景：批量截图时飞机一直在飞，
 * 同机位对照拍不成）。
 */
export function pinGeometry(sc) {
  const v = window.__voyage;
  const viewPresetGiven = sc.p && sc.p["view-preset"] !== undefined;
  if (sc.head !== undefined || !viewPresetGiven) {
    let hx = 0;
    let hy = 0.02;
    let hz = -0.3;
    if (Array.isArray(sc.head)) {
      hx = sc.head[0] ?? 0;
      hy = sc.head[1] ?? 0.02;
      hz = sc.head[2] ?? -0.3;
    } else if (typeof sc.head === "number") {
      hz = sc.head;
    }
    Object.assign(v.head, { tx: hx, ty: hy, x: hx, y: hy, tz: hz, z: hz });
  }
  if (sc.offset) v.cloudUniforms.uCloudOffset.value.set(sc.offset[0], sc.offset[1]);
}
