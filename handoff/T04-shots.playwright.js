// 回归场景：给 Playwright MCP 的 browser_run_code_unsafe 用（filename 参数指向本文件）。
// 用法：先在浏览器里打开要测的开发服务器（主分支 5181，worktree 用 5190+N），再运行本文件；
// 注意：工具会把文件内容包成「(内容)(page)」执行，文件末尾不能有分号。
// 会沿用当前页面的端口，依次设置固定场景并截图到 tmp/screenshot/regression/<场景名>.png（5181；其他端口是 regression-<端口>/，路径相对仓库根目录）。
// 新增一类效果时，把它的代表场景加进 SCENES。每个场景都从「默认状态」出发，互不影响。
async (page) => {
  const TAG = "ty4";
  const current = page.url();
  // 这里的执行环境没有全局 URL（ReferenceError），用正则取 origin
  const origin = (current.match(/^http:\/\/127\.0\.0\.1:5\d\d\d/) || ["http://127.0.0.1:5181"])[0];
  // 主分支（5181）写到 regression/，其他端口（worktree）写到 regression-<端口>/，并行的代理互不覆盖
  const port = origin.slice(-4);
  const outDir = `tmp/screenshot/T04/${TAG}-${port}`;
  const only = null; // 只跑某几个场景时改成名字数组，例如 ["fuji-day", "night-city"]

  // 场景：p = 面板上的设置（id → 值），extra = 额外的调试状态，wait = 等待毫秒，ground = 是否等地面瓦片
  const SCENES = [
    { name: "typhoon-eye", p: { preset: "wpac", time: 540, coverage: 0.2, weather: "typhoon-eye", "wing-pos": "-4" } },
    { name: "typhoon-eye-down", p: { preset: "wpac", time: 540, coverage: 0.2, weather: "typhoon-eye", "wing-pos": "-4" }, headY: 0.16, head: -0.12 },
    { name: "typhoon-eye-pm", p: { preset: "wpac", time: 960, coverage: 0.2, weather: "typhoon-eye", "wing-pos": "-4" } },
    { name: "typhoon-bands", p: { preset: "wpac", time: 900, coverage: 0.2, weather: "typhoon-bands", "wing-pos": "-4" } },
    { name: "typhoon-above", p: { preset: "wpac", time: 900, coverage: 0.2, altitude: 13, weather: "typhoon-outer", "wing-pos": "-4" }, headY: 0.16, head: -0.12 },
    { name: "storm-day", p: { preset: "wpac", time: 900, coverage: 0.3, weather: "storm", "wing-pos": "-4" } },
  ];

  await page.addInitScript(() => { window.__errs = []; const oe = console.error; console.error = (...a) => { window.__errs.push(a.map(String).join(" ").slice(0, 400)); oe.apply(console, a); }; });
  await page.goto(`${origin}/?regression=${Date.now()}`, { waitUntil: "commit", timeout: 180000 });
  await page.bringToFront();
  await page.waitForFunction(() => window.__voyageStartup, null, { timeout: 180000, polling: 500 });

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
      const hz = sc.head ?? -0.3;
      const hy = sc.headY ?? 0.02;
      Object.assign(v.head, { tx: 0, ty: hy, x: 0, y: hy, tz: hz, z: hz });
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
  // 帧时间（窗口在前台时）
  const frameMs = await page.evaluate(async () => {
    const t = [];
    await new Promise((res) => {
      let last = performance.now();
      let k = 0;
      function f() {
        const n = performance.now();
        t.push(n - last);
        last = n;
        if (++k < 30) requestAnimationFrame(f);
        else res();
      }
      requestAnimationFrame(f);
    });
    t.sort((a, b) => a - b);
    return +t[Math.floor(t.length / 2)].toFixed(2);
  });
  const errs = await page.evaluate(() => (window.__errs || []).slice(0, 5));
  return { origin, frameMsMedian: frameMs, results, errs };
}
