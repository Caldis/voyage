// T20 截图：5201 = 改前（基线副本），5200 = 改后。只跑某几个场景时改 ONLY；迭代中间版本改 SUFFIX
async (page) => {
  const ONLY = null;
  const SUFFIX = "";
  const current = page.url();
  const origin = (current.match(/^http:\/\/127\.0\.0\.1:52\d\d/) || ["http://127.0.0.1:5200"])[0];
  const tag = (origin.endsWith("5201") ? "before" : "after") + SUFFIX;
  const outDir = "D:/Code/opus-test/tmp/screenshot/T20";
  const D = { x: 0, y: 0.02, z: -0.42 };
  const NOON = { preset: "wpac", time: 720, "wing-pos": "8" };
  const SUNSET = { preset: "wpac", time: 1040, "wing-pos": "8" };
  const NIGHT = { preset: "fuji", time: 1260, altitude: 4, coverage: 0.15, "cabin-light": false };
  const FWD = { x: -0.42, y: 0.02, z: -0.6 };
  const OWN = { x: 0.42, y: 0.02, z: -0.6 };
  const SHOTS = [
    { name: "noon", p: NOON, head: D },
    { name: "noon-near", p: NOON, head: { x: 0, y: 0.02, z: -0.3 } },
    { name: "sunset", p: SUNSET, head: D },
    { name: "night", p: NIGHT, offset: [0, -25], head: { x: 0, y: 0.02, z: -0.25 } },
    { name: "night-default", p: NIGHT, offset: [0, -25], head: D },
    { name: "night-lighton", p: { ...NIGHT, "cabin-light": true }, offset: [0, -25], head: D },
    { name: "noon-shade", p: { ...NOON, shade: 0.45 }, head: D },
    { name: "noon-fwd", p: NOON, head: FWD },
    { name: "noon-own", p: NOON, head: OWN },
    { name: "sunset-fwd", p: SUNSET, head: FWD },
    { name: "night-fwd", p: NIGHT, offset: [0, -25], head: FWD },
    { name: "night-own", p: NIGHT, offset: [0, -25], head: OWN },
  ];
  const errs = [];
  const onMsg = (m) => { if (m.type() === "error" || /CONTEXT_LOST/.test(m.text())) errs.push(m.text().slice(0, 400)); };
  page.on("console", onMsg);
  const t0 = Date.now();
  await page.goto(`${origin}/?t20=${t0}`, { waitUntil: "commit", timeout: 180000 });
  await page.bringToFront();
  await page.waitForFunction(() => window.__voyageStartup, null, { timeout: 240000, polling: 500 });
  const loadMs = Date.now() - t0;
  await page.waitForTimeout(1500);
  if (errs.length) { page.off("console", onMsg); return { origin, aborted: true, errs: errs.slice(0, 5) }; }
  const results = [];
  for (const sc of SHOTS) {
    if (ONLY && !ONLY.includes(sc.name)) continue;
    await page.evaluate(async (sc) => {
      const v = window.__voyage;
      document.getElementById("panel").classList.add("hidden");
      const set = (id, val) => {
        const el = document.getElementById(id);
        if (el.type === "checkbox") { el.checked = val; el.dispatchEvent(new Event("change")); }
        else { el.value = String(val); el.dispatchEvent(new Event(el.tagName === "SELECT" ? "change" : "input")); }
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
    await page.screenshot({ path: `${outDir}/${tag}-${sc.name}.png`, timeout: 60000 });
    results.push(sc.name);
  }
  page.off("console", onMsg);
  return { origin, loadMs, vp: page.viewportSize(), results, errs: errs.slice(0, 5) };
}
