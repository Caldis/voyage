// 回归场景：给 Playwright MCP 的 browser_run_code_unsafe 用（filename 参数指向本文件）。
// 用法：先在浏览器里打开要测的开发服务器（主分支 5181，worktree 用 5190+N），再运行本文件；
// 注意：工具会把文件内容包成「(内容)(page)」执行，文件末尾不能有分号。
// 会沿用当前页面的端口，依次设置固定场景并截图到 tmp/screenshot/regression/<场景名>.png（5181；其他端口是 regression-<端口>/，路径相对仓库根目录）。
// 新增一类效果时，把它的代表场景加进 SCENES。每个场景都从「默认状态」出发，互不影响。
//
// DX-03（第 3 波开发体验官报告 §2-C）：
// - 开头固定 setViewportSize，避免「别的代理把窗口改成别的尺寸，帧时间涨几十倍且静默作废」这类事故
//   （第 2 波 T03 返工报告的真实事故）。
// - 返回值带 viewport / renderer / origin，方便核对这次跑的到底是哪个端口、哪个渲染器（不是 SwiftShader）；
//   origin 额外在最开头 console.log 一次（即使后面步骤失败也已经能看到这次跑的是哪个端口）。
// - 2026-09-26 审查追加返工：旧版端口正则只认 51\d\d（5100–5199），worktree 常用的 52xx 端口（例如
//   T16、T23 用过的 5230）匹配不上，会静默退回默认值 http://127.0.0.1:5181，把截图写进主分支的
//   tmp/screenshot/regression/、覆盖别人的基线（本波至少发生 3 次）。现在改成认任意 127.0.0.1:5\d{3}
//   （5000–5999），并且当前页面不在这个范围时直接抛错退出，不再有「猜一个默认端口」这条路。
// - only 现在可以从外部传入：优先读 globalThis.__regressionOnly（如果调用方在跑这个文件前预置了这个全局），
//   否则从当前页面 URL 的 `?only=a,b` 查询参数读——这个执行环境没有全局 URL（ReferenceError），也没有
//   Node 侧的 setTimeout，所以两处都用正则/page.evaluate 里的浏览器原生 setTimeout，不假设外层有这些全局。
// - 帧时间不再用原始 rAF 中位数（会被 vsync 锁在约 6.2 ms，测不出着色器代价，见 README 坑点），
//   改成调用 main.ts 已经提供的 `window.__voyage.benchFrame(30)`——一次 JS 调用里连续渲染 30 帧再
//   readRenderTargetPixels 同步一次，不经过 requestAnimationFrame，不受刷新率上限影响。
// - head 除了原来的数字（只设 z）以外，现在也接受 [x, y, z] 三元组（headX），用来表达邻座 / 前排座位
//   这类横向偏移（参考 T06 复核脚本的 forward-seat / own-seat 场景）。
// - DX-07：依赖月相 / 星空的夜景、黄昏场景全部写死 date（不写就用「打开页面当天」，月相每天都在变，跨波
//   对比会误判，第 6 波美术总监报告撞上过一次）。「城市夜景」类用无月夜（月亮在地平线下），另留一个专门看
//   月光的满月场景（night-sea-fullmoon）。月亮高度 / 方位用仓库自带的 astronomy-engine 算的（T09 用过的
//   同一套天文库），数值写在下面每条场景的注释里；与 scripts/scenarios.mjs 逐字同步。
//
// 维护提示：SCENES 数组与 apps/voyage/scripts/scenarios.mjs 里的同名导出逐字同步（那边是给 dev-browser.mjs
// 这个真 Node 脚本用 import 的单一源）。这个文件跑在 Playwright MCP 的沙箱执行环境里，没有全局 URL /
// setTimeout，大概率也没有 require/import（不是完整 Node，更像裸 vm 上下文），没办法安全地 import 那份模块，
// 所以两边各放一份；改场景表时两处一起改。
async (page) => {
  await page.setViewportSize({ width: 1600, height: 1200 });
  const current = page.url();
  // 这里的执行环境没有全局 URL（ReferenceError），用正则取 origin；接受任意 127.0.0.1:5xxx（5000–5999），
  // 不在这个范围就直接报错退出——不能猜一个默认端口，猜错了会把截图写进别人的目录、覆盖别人的基线
  const m = current.match(/^http:\/\/127\.0\.0\.1:5\d{3}\b/);
  if (!m) {
    throw new Error(`当前页面不是 http://127.0.0.1:5\\d{3}（实际 URL：${current}）。回归脚本不会猜端口，先导航到要测的开发服务器再跑。`);
  }
  const origin = m[0];
  console.log(origin); // 打在最前面：后面任何一步失败，这次跑的到底是哪个端口都已经看得到
  // 主分支（5181）写到 regression/，其他端口（worktree）写到 regression-<端口>/，并行的代理互不覆盖
  const port = origin.slice(-4);
  const outDir = port === "5181" ? "tmp/screenshot/regression" : `tmp/screenshot/regression-${port}`;
  // only：优先 globalThis.__regressionOnly（调用方可以在跑这个文件前预置），否则从当前 URL 的 ?only=a,b 读
  let only = (typeof globalThis !== "undefined" && globalThis.__regressionOnly) || null;
  if (!only) {
    const qm = current.match(/[?&]only=([^&]+)/);
    if (qm) only = qm[1].split(",");
  }

  // 场景：p = 面板上的设置（id → 值），offset = 云的世界偏移，wait = 等待毫秒，ground = 是否等地面瓦片，
  // head = 头部位置，数字只设 z（向后兼容），[x, y, z] 三元组可以表达横向座位偏移（headX）
  const SCENES = [
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
  ];

  await page.goto(`${origin}/?regression=${Date.now()}`, { waitUntil: "commit", timeout: 180000 });
  await page.bringToFront();
  await page.waitForFunction(() => window.__voyageStartup, null, { timeout: 180000, polling: 500 });

  const renderer = await page.evaluate(() => {
    const c = document.createElement("canvas");
    const gl = c.getContext("webgl2");
    if (!gl) return null;
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
  });

  const results = [];
  for (const sc of SCENES) {
    if (only && !only.includes(sc.name)) continue;
    const info = await page.evaluate(async (sc) => {
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
      // 默认状态
      const defaults = { preset: "wpac", seat: "right", weather: "fair", "cloud-preset": "cumulus", "cabin-light": true, "cabin-class": "business", altitude: 10.7, shade: 0, wind: 7, "wing-pos": "8", "ground-on": true };
      for (const [id, val] of Object.entries({ ...defaults, ...sc.p })) set(id, val);
      if (sc.p.coverage === undefined) set("coverage", 0.42);
      // 日期（T09）：场景没写 date 时恢复成页面打开时的日期，免得上一个写了 date 的场景把后面的场景也带到那一天
      window.__voyageInitialDate ??= document.getElementById("date").value;
      if (sc.p.date === undefined) set("date", window.__voyageInitialDate);
      if (sc.p.time !== undefined) set("time", sc.p.time);
      // 上一个场景留下的状态也要清掉（例如穿云后的窗上水痕、颠簸）
      v.state.wetness = 0;
      v.state.turbulence = 0.03;
      // head：数字只设 z（向后兼容），[x, y, z] 三元组可以额外表达横向座位偏移（headX）
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
      // js（T17，W01b 同步到这里）：一段脚本，参数 v = window.__voyage，在 snapAll 与截图等待之前执行（例如召唤奇观）
      const jsOut = sc.js ? await new (async () => {}).constructor("v", sc.js)(v) : undefined;
      v.snapAll();
      await new Promise((r) => setTimeout(r, sc.wait ?? 2500));
      const info = document.getElementById("info").textContent;
      return jsOut === undefined ? info : `${info}\njs: ${typeof jsOut === "string" ? jsOut : JSON.stringify(jsOut)}`;
    }, sc);
    const path = `${outDir}/${sc.name}.png`;
    await page.screenshot({ path, timeout: 60000 });
    results.push({ scene: sc.name, path, info });
  }
  // 帧时间：批渲 + 一次 readRenderTargetPixels 同步（main.ts 已经提供 window.__voyage.benchFrame），
  // 不再用会被 vsync 锁在 ~6.2 ms 的原始 rAF 中位数
  const frameMs = await page.evaluate(() => window.__voyage.benchFrame(30));
  return { origin, renderer, viewport: { width: 1600, height: 1200 }, frameMs: +frameMs.toFixed(2), results };
}
