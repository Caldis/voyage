// 回归场景：给 Playwright MCP 的 browser_run_code_unsafe 用（filename 参数指向本文件）。
// 用法：先在浏览器里打开要测的开发服务器（主分支 5181，worktree 用 5190+N），再运行本文件；
// 注意：工具会把文件内容包成「(内容)(page)」执行，文件末尾不能有分号。
// 会沿用当前页面的端口，依次设置固定场景并截图到 tmp/screenshot/regression/<场景名>.png（5181；其他端口是 regression-<端口>/，路径相对仓库根目录）。
// 新增一类效果时，把它的代表场景加进 SCENES。每个场景都从「默认状态」出发，互不影响。
//
// DX-03（第 3 波开发体验官报告 §2-C）：
// - 开头固定 setViewportSize，避免「别的代理把窗口改成别的尺寸，帧时间涨几十倍且静默作废」这类事故
//   （第 2 波 T03 返工报告的真实事故）。
// - 返回值带 viewport / renderer / origin，方便核对这次跑的到底是哪个端口、哪个渲染器（不是 SwiftShader）。
// - only 现在可以从外部传入：优先读 globalThis.__regressionOnly（如果调用方在跑这个文件前预置了这个全局），
//   否则从当前页面 URL 的 `?only=a,b` 查询参数读——这个执行环境没有全局 URL（ReferenceError），也没有
//   Node 侧的 setTimeout，所以两处都用正则/page.evaluate 里的浏览器原生 setTimeout，不假设外层有这些全局。
// - 帧时间不再用原始 rAF 中位数（会被 vsync 锁在约 6.2 ms，测不出着色器代价，见 README 坑点），
//   改成调用 main.ts 已经提供的 `window.__voyage.benchFrame(30)`——一次 JS 调用里连续渲染 30 帧再
//   readRenderTargetPixels 同步一次，不经过 requestAnimationFrame，不受刷新率上限影响。
// - head 除了原来的数字（只设 z）以外，现在也接受 [x, y, z] 三元组（headX），用来表达邻座 / 前排座位
//   这类横向偏移（参考 T06 复核脚本的 forward-seat / own-seat 场景）。
//
// 维护提示：SCENES 数组与 apps/voyage/scripts/scenarios.mjs 里的同名导出逐字同步（那边是给 dev-browser.mjs
// 这个真 Node 脚本用 import 的单一源）。这个文件跑在 Playwright MCP 的沙箱执行环境里，没有全局 URL /
// setTimeout，大概率也没有 require/import（不是完整 Node，更像裸 vm 上下文），没办法安全地 import 那份模块，
// 所以两边各放一份；改场景表时两处一起改。
async (page) => {
  await page.setViewportSize({ width: 1600, height: 1200 });
  const current = page.url();
  // 这里的执行环境没有全局 URL（ReferenceError），用正则取 origin
  const origin = (current.match(/^http:\/\/127\.0\.0\.1:51\d\d/) || ["http://127.0.0.1:5181"])[0];
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
    { name: "dusk-earthshadow", p: { preset: "wpac", seat: "left", time: 1068, "wing-pos": "-4" } },
    { name: "clouds-variety", p: { preset: "wpac", time: 900, coverage: 0.62, altitude: 5, "wing-pos": "-4" }, offset: [37, -12] },
    { name: "low-sea-glint", p: { preset: "wpac", time: 980, coverage: 0, altitude: 0.6, "wing-pos": "-4" } },
    { name: "in-cloud", p: { preset: "wpac", time: 840, "cloud-preset": "stratocumulus", coverage: 0.95, altitude: 1.35, "wing-pos": "8" }, wait: 6000 },
    { name: "storm-day", p: { preset: "wpac", time: 900, coverage: 0.3, weather: "storm", "wing-pos": "-4" } },
    { name: "typhoon-eye", p: { preset: "wpac", time: 540, coverage: 0.2, weather: "typhoon-eye", "wing-pos": "-4" } },
    { name: "fuji-day", p: { preset: "fuji", time: 930, altitude: 6, coverage: 0.1, "wing-pos": "-4" }, offset: [-20, 0.2], ground: true },
    { name: "night-city", p: { preset: "fuji", time: 1260, altitude: 4, coverage: 0.15, "cabin-light": false }, offset: [0, -25], ground: true, head: -0.25 },
    { name: "route-hnd-cts", p: { preset: "hnd-cts", time: 990, coverage: 0.25, "wing-pos": "8" }, ground: true },
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
          el.dispatchEvent(new Event(el.tagName === "SELECT" ? "change" : "input"));
        }
      };
      // 默认状态
      const defaults = { preset: "wpac", seat: "right", weather: "fair", "cloud-preset": "cumulus", "cabin-light": true, altitude: 10.7, shade: 0, wind: 7, "wing-pos": "8", "ground-on": true };
      for (const [id, val] of Object.entries({ ...defaults, ...sc.p })) set(id, val);
      if (sc.p.coverage === undefined) set("coverage", 0.42);
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
      v.snapAll();
      await new Promise((r) => setTimeout(r, sc.wait ?? 2500));
      return document.getElementById("info").textContent;
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
