async (page) => {
  // T04：改前(5214) / 改后(5204) 交替，30 帧批渲测时
  const ORIGINS = ["http://127.0.0.1:5214", "http://127.0.0.1:5204", "http://127.0.0.1:5214", "http://127.0.0.1:5204"];
  const SC = [
    { name: "noon-cumulus", p: { preset: "wpac", time: 720, "wing-pos": "8" }, head: [0, 0.02, -0.3], perf: true },
    { name: "clouds-variety", p: { preset: "wpac", time: 900, coverage: 0.62, altitude: 5, "wing-pos": "-4" }, offset: [37, -12], head: [0, 0.02, -0.3], perf: true },
    { name: "storm-day", p: { preset: "wpac", time: 900, coverage: 0.3, weather: "storm", "wing-pos": "-4" }, head: [0, 0.02, -0.3], perf: true },
    { name: "typhoon-eye", p: { preset: "wpac", time: 540, coverage: 0.2, weather: "typhoon-eye", "wing-pos": "-4" }, head: [0, 0.02, -0.3], perf: true },
    { name: "typhoon-bands", p: { preset: "wpac", time: 900, coverage: 0.2, weather: "typhoon-bands", "wing-pos": "-4" }, head: [0, 0.02, -0.3], perf: true },
  ];
  await page.addInitScript(() => {
    window.__errs = [];
    const oe = console.error;
    console.error = (...a) => { window.__errs.push(a.map(String).join(" ").slice(0, 300)); oe.apply(console, a); };
    const origGC = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (t, ...a) {
      const c = origGC.call(this, t, ...a);
      if (t === "webgl2" && c && !window.__gl) {
        window.__gl = c;
        window.__progs = [];
        const ol = c.linkProgram.bind(c);
        c.linkProgram = (p) => { window.__progs.push(p); return ol(p); };
      }
      return c;
    };
    const raf = window.requestAnimationFrame.bind(window);
    window.__batching = false;
    window.requestAnimationFrame = (cb) => { window.__appCb = cb; if (window.__batching) return 0; return raf(cb); };
    window.__batch = (N) => new Promise((res) => {
      raf((ts) => {
        window.__batching = true;
        const gl = window.__gl, px = new Uint8Array(4), t0 = performance.now();
        let t = ts;
        for (let i = 0; i < N; i++) { t += 16.7; window.__appCb(t); }
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
        const ms = (performance.now() - t0) / N;
        window.__batching = false;
        raf(window.__appCb);
        res(ms);
      });
    });
  });
  const out = [];
  for (const origin of ORIGINS) {
    const port = origin.slice(-4);
    const t0 = Date.now();
    await page.goto(`${origin}/?t04perf=${t0}`, { waitUntil: "commit", timeout: 180000 });
    await page.bringToFront();
    await page.waitForFunction(() => window.__voyageStartup, null, { timeout: 300000, polling: 500 });
    await page.evaluate(() => {
      const o = window.__voyage.cloudUniforms.uCloudOffset.value;
      let X = o.x, Y = o.y;
      Object.defineProperty(o, "x", { get: () => X, set: (n) => { if (!window.__frz) X = n; }, configurable: true });
      Object.defineProperty(o, "y", { get: () => Y, set: (n) => { if (!window.__frz) Y = n; }, configurable: true });
    });
    const samplers = await page.evaluate(() => {
      const gl = window.__gl, S = [gl.SAMPLER_2D, gl.SAMPLER_3D, gl.SAMPLER_CUBE, gl.SAMPLER_2D_ARRAY, gl.SAMPLER_2D_SHADOW, gl.INT_SAMPLER_2D, gl.UNSIGNED_INT_SAMPLER_2D];
      return window.__progs.map((p) => {
        const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS) || 0;
        let s = 0, names = [];
        for (let i = 0; i < n; i++) { const u = gl.getActiveUniform(p, i); if (S.includes(u.type)) { s++; names.push(u.name); } }
        return { n, s, hasLoop: names.length && n, names: s >= 10 ? names.join(",") : "" };
      }).filter((x) => x.s >= 8);
    });
    const res = { port, loadMs: Date.now() - t0, startup: await page.evaluate(() => JSON.stringify(window.__voyageStartup)), samplers, scenes: {} };
    for (const sc of SC.filter((s) => s.perf)) {
      await page.evaluate(async (sc) => {
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
        v.cloudUniforms.uCloudOffset.value.set(sc.offset ? sc.offset[0] : 0, sc.offset ? sc.offset[1] : 0);
        if (sc.p.weather) set("weather", sc.p.weather);
        window.__frz = true;
        v.snapAll();
        await new Promise((r) => setTimeout(r, 2500));
      }, sc);
      const r = {};
      if (0) await page.screenshot({ path: `tmp/screenshot/review-t06/${port}/${sc.name}.png`, timeout: 60000 });
      if (sc.twice) {
        await page.waitForTimeout(300);
        if (0) await page.screenshot({ path: `tmp/screenshot/review-t06/${port}/${sc.name}-b.png`, timeout: 60000 });
      }
      if (sc.perf) {
        const ms = [];
        await page.evaluate(() => window.__batch(5));
        for (let k = 0; k < 3; k++) ms.push(await page.evaluate(() => window.__batch(30)));
        r.ms = ms.map((x) => +x.toFixed(2));
      }
      res.scenes[sc.name] = r;
    }
    res.errs = await page.evaluate(() => window.__errs.slice(0, 5));
    out.push(res);
  }
  return out;
}
