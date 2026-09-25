// T06 截图：舷窗周边 / 侧壁 / 座椅。沿用当前页面的端口；5189 = 改前，5197 = 改后
async (page) => {
  const current = page.url();
  const origin = (current.match(/^http:\/\/127\.0\.0\.1:51\d\d/) || ["http://127.0.0.1:5197"])[0];
  const tag = origin.endsWith("5189") ? "before" : "after";
  const outDir = "tmp/screenshot/T06";
  const only = null;
  const H0 = { x: 0, y: 0.02, z: -0.3 };
  const SHOTS = [
    { name: "noon", p: { preset: "wpac", time: 720, "wing-pos": "8" }, head: H0 },
    { name: "sunset", p: { preset: "wpac", time: 1040, "wing-pos": "8" }, head: H0 },
    { name: "night", p: { preset: "fuji", time: 1260, altitude: 4, coverage: 0.15, "cabin-light": false }, offset: [0, -25], head: { x: 0, y: 0.02, z: -0.25 } },
    { name: "noon-shade", p: { preset: "wpac", time: 720, "wing-pos": "8", shade: 0.45 }, head: { x: 0, y: 0.02, z: -0.42 } },
    { name: "sunset-shade", p: { preset: "wpac", time: 1040, "wing-pos": "8", shade: 0.45 }, head: { x: 0, y: 0.02, z: -0.42 } },
    { name: "noon-back", p: { preset: "wpac", time: 720, "wing-pos": "8" }, head: { x: 0, y: 0.02, z: -0.75 } },
    { name: "noon-fwdseat", p: { preset: "wpac", time: 720, "wing-pos": "8" }, head: { x: -0.14, y: 0.02, z: -0.75 }, wide: true },
    { name: "noon-fwdseat-half", p: { preset: "wpac", time: 720, "wing-pos": "8" }, head: { x: -0.14, y: 0.02, z: -0.75 }, wide: "half" },
    { name: "noon-ownseat", p: { preset: "wpac", time: 720, "wing-pos": "8" }, head: { x: 0.14, y: 0.02, z: -0.75 } },
    { name: "sunset-fwdseat", p: { preset: "wpac", time: 1040, "wing-pos": "8" }, head: { x: -0.14, y: 0.02, z: -0.75 }, wide: true },
    { name: "sunset-ownseat", p: { preset: "wpac", time: 1040, "wing-pos": "8" }, head: { x: 0.14, y: 0.02, z: -0.75 } },
    { name: "night-fwdseat", p: { preset: "fuji", time: 1260, altitude: 4, coverage: 0.15, "cabin-light": false }, offset: [0, -25], head: { x: -0.14, y: 0.02, z: -0.75 }, wide: true },
    { name: "night-ownseat", p: { preset: "fuji", time: 1260, altitude: 4, coverage: 0.15, "cabin-light": false }, offset: [0, -25], head: { x: 0.14, y: 0.02, z: -0.75 } },
  ];

  const errs = [];
  const onMsg = (m) => { if (m.type() === "error" || /CONTEXT_LOST/.test(m.text())) errs.push(m.text().slice(0, 300)); };
  page.on("console", onMsg);
  await page.goto(`${origin}/?t06=${Date.now()}`, { waitUntil: "commit", timeout: 180000 });
  await page.bringToFront();
  await page.waitForFunction(() => window.__voyageStartup, null, { timeout: 180000, polling: 500 });
  await page.waitForTimeout(1500);
  if (errs.length) { page.off("console", onMsg); return { origin, aborted: true, errs: errs.slice(0, 5) }; }
  const vp0 = page.viewportSize() || { width: 1880, height: 1835 };
  await page.setViewportSize(vp0);

  const measure = () =>
    page.evaluate(async () => {
      const t = [];
      await new Promise((res) => {
        let last = performance.now();
        let k = 0;
        function f() {
          const n = performance.now();
          t.push(n - last);
          last = n;
          if (++k < 60) requestAnimationFrame(f);
          else res();
        }
        requestAnimationFrame(f);
      });
      t.sort((a, b) => a - b);
      return +t[Math.floor(t.length / 2)].toFixed(2);
    });

  const results = [];
  const frames = {};
  for (const sc of SHOTS) {
    if (only && !only.includes(sc.name)) continue;
    const wantVp = sc.wide === "half" ? { width: 960, height: 540 } : sc.wide ? { width: 1920, height: 1080 } : vp0;
    const cur = page.viewportSize();
    if (cur.width !== wantVp.width || cur.height !== wantVp.height) {
      await page.setViewportSize(wantVp);
      await page.waitForTimeout(800);
    }
    await page.evaluate(async (sc) => {
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
      const defaults = { preset: "wpac", seat: "right", weather: "fair", "cloud-preset": "cumulus", "cabin-light": true, altitude: 10.7, shade: 0, wind: 7, "wing-pos": "8", "ground-on": true };
      for (const [id, val] of Object.entries({ ...defaults, ...sc.p })) set(id, val);
      if (sc.p.coverage === undefined) set("coverage", 0.42);
      if (sc.p.time !== undefined) set("time", sc.p.time);
      v.state.wetness = 0;
      v.state.turbulence = 0.0;
      const h = sc.head;
      Object.assign(v.head, { tx: h.x, ty: h.y, x: h.x, y: h.y, tz: h.z, z: h.z });
      v.cloudUniforms.uCloudOffset.value.set(sc.offset ? sc.offset[0] : 0, sc.offset ? sc.offset[1] : 0);
      v.snapAll();
      await new Promise((r) => setTimeout(r, 2500));
    }, sc);
    const path = `${outDir}/${tag}-${sc.name}.png`;
    await page.screenshot({ path, timeout: 60000 });
    results.push(path);
    if (sc.name === "noon" || sc.name === "noon-fwdseat" || sc.name === "noon-ownseat") frames[sc.name] = await measure();
  }
  const frameDefault = await measure();
  await page.setViewportSize(vp0);
  page.off("console", onMsg);
  return { origin, vp0, frameMsMedian: frameDefault, frames, results, errs: errs.slice(0, 5) };
}
