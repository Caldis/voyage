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
  { name: "dusk-earthshadow", p: { preset: "wpac", seat: "left", time: 1068, "wing-pos": "-4" } },
  { name: "clouds-variety", p: { preset: "wpac", time: 900, coverage: 0.62, altitude: 5, "wing-pos": "-4" }, offset: [37, -12] },
  { name: "low-sea-glint", p: { preset: "wpac", time: 980, coverage: 0, altitude: 0.6, "wing-pos": "-4" } },
  { name: "in-cloud", p: { preset: "wpac", time: 840, "cloud-preset": "stratocumulus", coverage: 0.95, altitude: 1.35, "wing-pos": "8" }, wait: 6000 },
  { name: "storm-day", p: { preset: "wpac", time: 900, coverage: 0.3, weather: "storm", "wing-pos": "-4" } },
  { name: "typhoon-eye", p: { preset: "wpac", time: 540, coverage: 0.2, weather: "typhoon-eye", "wing-pos": "-4" } },
  { name: "typhoon-bands", p: { preset: "wpac", time: 900, coverage: 0.2, weather: "typhoon-bands", "wing-pos": "-4" } },
  { name: "typhoon-outer", p: { preset: "wpac", time: 900, coverage: 0.2, altitude: 13, weather: "typhoon-outer", "wing-pos": "-4" } },
  { name: "fuji-day", p: { preset: "fuji", time: 930, altitude: 6, coverage: 0.1, "wing-pos": "-4" }, offset: [-20, 0.2], ground: true },
  { name: "night-city", p: { preset: "fuji", time: 1260, altitude: 4, coverage: 0.15, "cabin-light": false }, offset: [0, -25], ground: true, head: -0.25 },
  { name: "night-city-on", p: { preset: "fuji", time: 1260, altitude: 4, coverage: 0.15, "cabin-light": true }, offset: [0, -25], ground: true, head: -0.25 },
  { name: "night-city-off", p: { preset: "fuji", time: 1260, altitude: 4, coverage: 0.15, "cabin-light": "off" }, offset: [0, -25], ground: true, head: -0.25 },
  { name: "route-hnd-cts", p: { preset: "hnd-cts", time: 990, coverage: 0.25, "wing-pos": "8" }, ground: true },
  { name: "route-hnd-cts-night", p: { preset: "hnd-cts", time: 1290, coverage: 0.1, seat: "left", "cabin-light": false, "wing-pos": "8" }, ground: true },
  { name: "economy-ahead", p: { preset: "wpac", time: 720, "wing-pos": "8", "cabin-class": "economy" }, head: [-0.42, 0.1, -0.5] },
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
      el.dispatchEvent(new Event(el.tagName === "SELECT" ? "change" : "input"));
    }
  };
  for (const [id, val] of Object.entries({ ...defaults, ...sc.p })) set(id, val);
  if (sc.p.coverage === undefined) set("coverage", 0.42);
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
  // 舱等（T25）：没编过的变体在后台编译，画面切过去之前不截图（最多等 120 s）
  const wantClass = sc.p["cabin-class"] ?? "business";
  for (let i = 0; i < 480 && v.cabinClass && v.cabinClass.shown !== wantClass; i++) await new Promise((r) => setTimeout(r, 250));
  v.snapAll();
  await new Promise((r) => setTimeout(r, sc.wait ?? 2500));
  return document.getElementById("info").textContent;
}

/** 按名字过滤场景表；only 为空 / null 时返回全部 */
export function pickScenes(only) {
  if (!only || only.length === 0) return SCENES;
  const set = new Set(only);
  return SCENES.filter((s) => set.has(s.name));
}
