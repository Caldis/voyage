// T21：俯视海面重复的定位与前后对比截图。给 Playwright MCP 的 browser_run_code_unsafe（filename 参数）用。
// 沿用当前页面的端口（先 navigate 到 5221 或对照端口），截图到 tmp/screenshot/T21/<端口>/<名字>.png。
// MODE：「loc」= 定位（逐级关掉级联、调试模式）；「cmp」= 前后对比的三个视角
async (page) => {
  const MODE = "cmp";
  const current = page.url();
  const origin = (current.match(/^http:\/\/127\.0\.0\.1:5\d\d\d/) || ["http://127.0.0.1:5221"])[0];
  const port = origin.slice(-4);
  const outDir = `tmp/screenshot/T21/${port}`;
  await page.goto(`${origin}/?t21=${Date.now()}`, { waitUntil: "commit", timeout: 180000 });
  await page.bringToFront();
  await page.waitForFunction(() => window.__voyageStartup, null, { timeout: 300000, polling: 500 });
  await page.evaluate(() => {
    const o = window.__voyage.cloudUniforms.uCloudOffset.value;
    let X = o.x, Y = o.y;
    Object.defineProperty(o, "x", { get: () => X, set: (n) => { if (!window.__frz) X = n; }, configurable: true });
    Object.defineProperty(o, "y", { get: () => Y, set: (n) => { if (!window.__frz) Y = n; }, configurable: true });
  });
  // 俯视：头抬到最高、贴近窗，视线斜向下约 50°
  const DOWN = [0, 0.18, -0.08];
  const scenes = {
    loc: [
      { name: "down", p: { time: 720, coverage: 0 }, head: DOWN },
      { name: "down-no0", p: { time: 720, coverage: 0 }, head: DOWN, kill: [0] },
      { name: "down-no1", p: { time: 720, coverage: 0 }, head: DOWN, kill: [1] },
      { name: "down-no2", p: { time: 720, coverage: 0 }, head: DOWN, kill: [2] },
      { name: "down-no012", p: { time: 720, coverage: 0 }, head: DOWN, kill: [0, 1, 2] },
      { name: "down-dbg12", p: { time: 720, coverage: 0 }, head: DOWN, debug: 12 },
      { name: "down-dbg11", p: { time: 720, coverage: 0 }, head: DOWN, debug: 11 },
      { name: "down-dbg8", p: { time: 720, coverage: 0 }, head: DOWN, debug: 8 },
    ],
    cmp: [
      { name: "down", p: { time: 720, coverage: 0 }, head: DOWN },
      { name: "down-clouds", p: { time: 720 }, head: DOWN },
      { name: "down-am", p: { time: 600, coverage: 0 }, head: DOWN },
      { name: "down-dbg12", p: { time: 720, coverage: 0 }, head: DOWN, debug: 12 },
      { name: "low-sea-glint", p: { time: 980, coverage: 0, altitude: 0.6, "wing-pos": "-4" }, head: [0, 0.02, -0.3] },
      { name: "sunset-wing", p: { time: 1040, "wing-pos": "8" }, head: [0, 0.02, -0.3] },
      { name: "noon-cumulus", p: { time: 720, "wing-pos": "8" }, head: [0, 0.02, -0.3] },
    ],
  }[MODE];
  const out = [];
  for (const sc of scenes) {
    const info = await page.evaluate(async (sc) => {
      window.__frz = false;
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
      v.state.turbulence = 0;
      const h = sc.head;
      Object.assign(v.head, { tx: h[0], ty: h[1], x: h[0], y: h[1], tz: h[2], z: h[2] });
      v.cloudUniforms.uCloudOffset.value.set(0, 0);
      window.__frz = true;
      const U = v.sceneMat.uniforms;
      U.uDebug.value = sc.debug ?? 0;
      const tiles = [1531.1, 211.37, 29.17];
      U.uOceanTile.value.set(...tiles.map((L, c) => ((sc.kill ?? []).includes(c) ? 1e7 : L)));
      v.snapAll();
      await new Promise((r) => setTimeout(r, 2500));
      // 画面中心与四角的视线落在海面上的距离、像素足迹
      const B = U.uCamBasis.value.elements, W = U.uCabinToWorld.value.elements;
      const res = U.uResolution.value, tanH = U.uTanHalfFov.value, camR = U.uCamR.value;
      const mul = (m, x) => [m[0] * x[0] + m[3] * x[1] + m[6] * x[2], m[1] * x[0] + m[4] * x[1] + m[7] * x[2], m[2] * x[0] + m[5] * x[1] + m[8] * x[2]];
      const hit = (fx, fy) => {
        const nx = (fx * 2 - 1) * (res.x / res.y) * tanH, ny = (fy * 2 - 1) * tanH;
        let d = mul(B, [nx, ny, -1]);
        const l = Math.hypot(...d); d = d.map((a) => a / l);
        d = mul(W, d);
        const b = camR * d[1], c = camR * camR - 6360 * 6360, disc = b * b - c;
        if (b > 0 || disc < 0) return null;
        const t = -b - Math.sqrt(disc);
        return { t: +t.toFixed(2), x: +(d[0] * t).toFixed(2), z: +(d[2] * t).toFixed(2) };
      };
      const pts = { c: hit(0.5, 0.5), l: hit(0, 0.5), r: hit(1, 0.5), b: hit(0.5, 0), t: hit(0.5, 1) };
      return { pts, pixM: pts.c ? +(pts.c.t * 1000 * 2 * tanH / res.y).toFixed(2) : null, res: [res.x, res.y], info: document.getElementById("info").textContent.slice(0, 120) };
    }, sc);
    await page.screenshot({ path: `${outDir}/${sc.name}.png`, timeout: 60000 });
    out.push({ name: sc.name, ...info });
  }
  await page.evaluate(() => {
    const U = window.__voyage.sceneMat.uniforms;
    U.uDebug.value = 0;
    U.uOceanTile.value.set(1531.1, 211.37, 29.17);
  });
  return out;
}
