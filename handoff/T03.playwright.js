// 回归场景：给 Playwright MCP 的 browser_run_code_unsafe 用（filename 参数指向本文件）。
// 用法：先在浏览器里打开要测的开发服务器（主分支 5181，worktree 用 5190+N），再运行本文件；
// 注意：工具会把文件内容包成「(内容)(page)」执行，文件末尾不能有分号。
// 会沿用当前页面的端口，依次设置固定场景并截图到 tmp/screenshot/regression/<场景名>.png（5181；其他端口是 regression-<端口>/，路径相对仓库根目录）。
// 新增一类效果时，把它的代表场景加进 SCENES。每个场景都从「默认状态」出发，互不影响。
async (page) => {
  const TAG = "final";
  const ONLY = null;
  const current = page.url();
  // 这里的执行环境没有全局 URL（ReferenceError），用正则取 origin
  const origin = (current.match(/^http:\/\/127\.0\.0\.1:51\d\d/) || ["http://127.0.0.1:5181"])[0];
  // 主分支（5181）写到 regression/，其他端口（worktree）写到 regression-<端口>/，并行的代理互不覆盖
  const port = origin.slice(-4);
  const outDir = `tmp/screenshot/T03/${TAG}`;
  const only = ONLY; // 只跑某几个场景时改成名字数组，例如 ["fuji-day", "night-city"]

  // 场景：p = 面板上的设置（id → 值），extra = 额外的调试状态，wait = 等待毫秒，ground = 是否等地面瓦片
  const SCENES = [
    { name: "noon-cumulus", p: { preset: "wpac", time: 720, "wing-pos": "8" } },
    { name: "sunset-wing", p: { preset: "wpac", time: 1040, "wing-pos": "8" } },
    { name: "dusk-earthshadow", p: { preset: "wpac", seat: "left", time: 1068, "wing-pos": "-4" } },
    { name: "clouds-variety", p: { preset: "wpac", time: 900, coverage: 0.62, altitude: 5, "wing-pos": "-4" }, offset: [37, -12] },
    { name: "low-sea-glint", p: { preset: "wpac", time: 980, coverage: 0, altitude: 0.6, "wing-pos": "-4" } },
    { name: "in-cloud", p: { preset: "wpac", time: 840, "cloud-preset": "stratocumulus", coverage: 0.95, altitude: 1.35, "wing-pos": "8" }, wait: 6000 },
    { name: "storm-day", p: { preset: "wpac", time: 900, coverage: 0.3, weather: "storm", "wing-pos": "-4" } },
    { name: "storm-night", p: { preset: "wpac", time: 1320, coverage: 0.3, weather: "storm", "wing-pos": "-4", "cabin-light": false } },
    { name: "storm-night-flash", p: { preset: "wpac", time: 1320, coverage: 0.3, weather: "storm", "wing-pos": "-4", "cabin-light": false }, flash: [0, 5, 300] },
    { name: "storm-night-cg", p: { preset: "wpac", time: 1320, coverage: 0.3, weather: "storm", "wing-pos": "-4", "cabin-light": false }, flash: [-3, 2, 300], cg: true },
    { name: "storm-cg-near", p: { preset: "wpac", time: 1320, coverage: 0.3, weather: "storm", altitude: 2, "wing-pos": "-4", "cabin-light": false }, near: 14, flash: [-4, 2, 300], cg: true },
    { name: "storm-cg-near-dim", p: { preset: "wpac", time: 1320, coverage: 0.3, weather: "storm", altitude: 2, "wing-pos": "-4", "cabin-light": false }, near: 14, flash: [-4, 2, 20], cg: true },
    { name: "storm-frontlit", p: { preset: "wpac", seat: "left", time: 900, coverage: 0.3, weather: "storm", "wing-pos": "-4" } },
    { name: "squall", p: { preset: "wpac", time: 900, coverage: 0.3, weather: "squall", "wing-pos": "-4" } },
    { name: "storm-near", p: { preset: "wpac", time: 900, coverage: 0.3, weather: "storm", "wing-pos": "-4" }, near: 28 },
    { name: "storm-low", p: { preset: "wpac", time: 900, coverage: 0.3, weather: "storm", altitude: 3, "wing-pos": "-4" }, near: 30 },
    { name: "typhoon-eye", p: { preset: "wpac", time: 540, coverage: 0.2, weather: "typhoon-eye", "wing-pos": "-4" } },
    { name: "fuji-day", p: { preset: "fuji", time: 930, altitude: 6, coverage: 0.1, "wing-pos": "-4" }, offset: [-20, 0.2], ground: true },
    { name: "night-city", p: { preset: "fuji", time: 1260, altitude: 4, coverage: 0.15, "cabin-light": false }, offset: [0, -25], ground: true, head: -0.25 },
    { name: "route-hnd-cts", p: { preset: "hnd-cts", time: 990, coverage: 0.25, "wing-pos": "8" }, ground: true },
  ];

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
      Object.assign(v.head, { tx: 0, ty: 0.02, x: 0, y: 0.02, tz: hz, z: hz });
      if (sc.offset) v.cloudUniforms.uCloudOffset.value.set(sc.offset[0], sc.offset[1]);
      // 天气要在位移设好之后重新摆放
      const w = v.weather;
      if (!w.__origUpdate) w.__origUpdate = w.update;
      w.update = w.__origUpdate;
      w.hold = false;
      if (sc.p.weather) set("weather", sc.p.weather);
      if (sc.near && w.storms.length) {
        // 把雷暴沿窗外方向拉近到 near km（保持方位），重新同步 uniform
        const off = v.cloudUniforms.uCloudOffset.value;
        const s0 = w.storms[0];
        const dx = s0.x - off.x, dz = s0.z - off.y, d = Math.hypot(dx, dz);
        s0.x = off.x + dx / d * sc.near; s0.z = off.y + dz / d * sc.near;
        w.syncUniforms();
      }
      if (sc.ground) {
        for (let i = 0; i < 40; i++) {
          await new Promise((r) => setTimeout(r, 1000));
          if (v.ground.pending < 5 && i > 5) break;
        }
      }
      if (sc.flash) {
        // 先让闪电调度静止（没有随机闪光），画面收敛后再固定一次闪光，拍它的峰值附近
        w.update = () => { w.u.uFlash.value.w = 0; w.boltIntensity = 0; };
      }
      v.snapAll();
      await new Promise((r) => setTimeout(r, sc.wait ?? 2500));
      if (sc.flash) {
        const s0 = w.storms[0];
        const fx = s0.x + sc.flash[0], fz = s0.z, fy = sc.flash[1], I = sc.flash[2];
        if (w.flashNow) {
          w.update = w.__origUpdate;
          w.flashNow(0, !!sc.cg, true, I);
          // 固定通道位置，前后对比才有意义
          w.flashPos.set(fx, sc.cg ? 1.3 : fy, fz);
          w.flashEnd.set(fx + (sc.cg ? 1 : 6), sc.cg ? 5 : fy + 1, fz + 2);
        } else {
          if (sc.cg) { w.makeBolt(fx, fz); } else { w.boltCount = 0; }
          w.update = () => {
            w.u.uFlash.value.set(fx, fy, fz, I);
            w.boltIntensity = sc.cg ? I : 0;
          };
        }
        await new Promise((r) => setTimeout(r, 220));
      }
      return document.getElementById("info").textContent;
    }, sc);
    const path = `${outDir}/${sc.name}.png`;
    await page.screenshot({ path, timeout: 60000 });
    const fm = await page.evaluate(async () => {
      const t = [];
      await new Promise((res) => { let last = performance.now(); let k = 0; function f() { const n = performance.now(); t.push(n - last); last = n; if (++k < 40) requestAnimationFrame(f); else res(); } requestAnimationFrame(f); });
      t.sort((a, b) => a - b);
      return +t[Math.floor(t.length / 2)].toFixed(2);
    });
    results.push({ scene: sc.name, fm });
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
  return { origin, frameMsMedian: frameMs, results };
}
