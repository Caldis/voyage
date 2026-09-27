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
};

export const SCENES = [
  { name: "noon-cumulus", p: { preset: "wpac", time: 720, "wing-pos": "8" } },
  { name: "sunset-wing", p: { preset: "wpac", time: 1040, "wing-pos": "8" } },
  // DX-07：wpac 17:48 本地，2026-02-16 太阳高度 −4.7°（与旧行为的「当天」量级一致，地影拱仍在合适位置），
  // 月亮高度 −19.3°（新月相位 1%，在地平线下），不会露头
  { name: "dusk-earthshadow", p: { preset: "wpac", seat: "left", date: "2026-02-16", time: 1068, "wing-pos": "-4" } },
  { name: "clouds-variety", p: { preset: "wpac", time: 900, coverage: 0.62, altitude: 5, "wing-pos": "-4" }, offset: [37, -12] },
  { name: "low-sea-glint", p: { preset: "wpac", time: 980, coverage: 0, altitude: 0.6, "wing-pos": "-4" } },
  { name: "in-cloud", p: { preset: "wpac", time: 840, "cloud-preset": "stratocumulus", coverage: 0.95, altitude: 1.35, "wing-pos": "8" }, wait: 6000 },
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
  { name: "economy-ahead", p: { preset: "wpac", time: 720, "wing-pos": "8", "cabin-class": "economy" }, head: [-0.42, 0.1, -0.5] },
  // T09：夜间无月（2026-05-15 22:30，残月在地平线下 53°）、关舱灯（全关）、南海上空、左座朝东南：人马座大星云低低地在窗正中
  { name: "night-sea-milkyway", p: { preset: "scs", seat: "left", date: "2026-05-15", time: 1350, coverage: 0.15, "cabin-light": "off", "wing-pos": "-4" } },
  // DX-07：专看月光的满月场景。scs 22:30 本地，2026-04-01 月亮相位 99.7%（近满月）、高度 58°、方位 133.8°，
  // 几乎正对左座窗外方位（heading 225 − 90 = 135°），月亮应该稳稳地挂在窗正中
  { name: "night-sea-fullmoon", p: { preset: "scs", seat: "left", date: "2026-04-01", time: 1350, coverage: 0.15, "cabin-light": "off", "wing-pos": "-4" } },
  // W01b：奇观（天幕层，js 召唤：放在窗口正对方向、直接显形；召唤前等两帧，让奇观系统拿到新的座位 / 航向）。
  // 天梯：左座朝东、日落后约 20 分钟（太阳约 −6.5°），下段已入地影，上段与高处的中继站仍被阳光照亮，缆上红色障碍灯同步慢闪
  { name: "wonder-tether-dusk", p: { preset: "wpac", seat: "left", date: "2026-09-27", time: 1078, coverage: 0.3, "cabin-light": false, "wing-pos": "-4" }, js: "v.wonders.enabled = true; for (let i = 0; i < 2; i++) await new Promise((r) => requestAnimationFrame(r)); v.wonders.trigger(\"tether\", { forwardOffsetDeg: 0, distKm: 370, reveal: 1 }); return v.wonders.describe();" },
  // 建木，白天（下午）：缠着树干旋上去的云气是白天最先被注意到的东西，九欘（弯枝）在窗里的高处
  { name: "wonder-jianmu-day", p: { preset: "wpac", date: "2026-09-27", time: 900, coverage: 0.3, "wing-pos": "-4" }, js: "v.wonders.enabled = true; for (let i = 0; i < 2; i++) await new Promise((r) => requestAnimationFrame(r)); v.wonders.trigger(\"jianmu\", { forwardOffsetDeg: 0, distKm: 380, reveal: 1 }); return v.wonders.describe();" },
  // W02：雾海灯城（云间层，js 召唤，种子写死 0.37 让画面可复现；召唤后等云间层变体后台编好再截图）。
  // wpac 22:00 本地、2026-01-16 无月夜（月亮 −88°、太阳 −64°），右座朝西，城心在 95 km 外正对窗口：
  // 被灯海染橙的雾、雾里的阶梯金字塔剪影、火炬、探照光束、雾下的车流灯带
  { name: "wonder-fogcity-night", p: { preset: "wpac", date: "2026-01-16", time: 1320, coverage: 0.15, "cabin-light": false, "wing-pos": "-4" }, wait: 4000, js: "v.wonders.enabled = true; for (let i = 0; i < 2; i++) await new Promise((r) => requestAnimationFrame(r)); v.wonders.trigger(\"fogcity\", { forwardOffsetDeg: 0, distKm: 95, reveal: 1, seed: 0.37 }); for (let i = 0; i < 240 && v.clouds.wonderLayerState !== \"ready\"; i++) await new Promise((r) => setTimeout(r, 250)); return v.wonders.describe() + \" · \" + v.clouds.wonderLayerState;" },
];

/**
 * 在浏览器里应用一个场景（用法：`page.evaluate(applyScene, { sc, defaults: DEFAULTS })`）。
 * 必须是纯函数：page.evaluate 只序列化函数自身的源码，任何外部闭包变量（包括本文件里的 DEFAULTS）
 * 到了浏览器那边都不存在，所以 defaults 通过参数传入，不是靠模块顶层的引用。
 */
export async function applyScene(arg) {
  const { sc, defaults } = arg;
  const v = window.__voyage;
  document.getElementById("panel").classList.add("hidden");
  const set = (id, val) => {
    const el = document.getElementById(id);
    if (el.type === "checkbox") {
      el.checked = val;
      el.dispatchEvent(new Event("change"));
    } else {
      el.value = String(val);
      // 日期框只响应 change（ui.ts）
      el.dispatchEvent(new Event(el.tagName === "SELECT" || el.type === "date" ? "change" : "input"));
    }
  };
  for (const [id, val] of Object.entries({ ...defaults, ...sc.p })) set(id, val);
  if (sc.p.coverage === undefined) set("coverage", 0.42);
  // 日期（T09）：场景没写 date 时恢复成页面打开时的日期，免得上一个写了 date 的场景把后面的场景也带到那一天
  window.__voyageInitialDate ??= document.getElementById("date").value;
  if (sc.p.date === undefined) set("date", window.__voyageInitialDate);
  if (sc.p.time !== undefined) set("time", sc.p.time);
  // 上一个场景留下的状态也要清掉（例如穿云后的窗上水痕、颠簸）
  v.state.wetness = 0;
  v.state.turbulence = 0.03;
  // head：数字只设 z（向后兼容），[x,y,z] 三元组可以额外表达横向座位偏移（DX-03 headX）
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
  if (sc.offset) v.cloudUniforms.uCloudOffset.value.set(sc.offset[0], sc.offset[1]);
  // 天气要在位移设好之后重新摆放
  if (sc.p.weather) set("weather", sc.p.weather);
  if (sc.ground) {
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      if (v.ground.pending < 5 && i > 5) break;
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
  const jsOut = sc.js ? await new (async () => {}).constructor("v", sc.js)(v) : undefined;
  v.snapAll();
  await new Promise((r) => setTimeout(r, sc.wait ?? 2500));
  const info = document.getElementById("info").textContent;
  return jsOut === undefined ? info : `${info}
js: ${typeof jsOut === "string" ? jsOut : JSON.stringify(jsOut)}`;
}

/** 按名字过滤场景表；only 为空 / null 时返回全部 */
export function pickScenes(only) {
  if (!only || only.length === 0) return SCENES;
  const set = new Set(only);
  return SCENES.filter((s) => set.has(s.name));
}
