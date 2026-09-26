// T21 帧时间：主分支（5222）与本分支（5221）交替，一个 rAF 回调里连渲 30 帧再 readPixels（改自 tmp/review-t06/perf.js）
async (page) => {
  const ORIGINS = ["http://127.0.0.1:5222", "http://127.0.0.1:5221", "http://127.0.0.1:5222", "http://127.0.0.1:5221"];
  const SC = [
    { name: "down", p: { time: 720, coverage: 0 }, head: [0, 0.18, -0.08] },
    { name: "low-sea-glint", p: { time: 980, coverage: 0, altitude: 0.6, "wing-pos": "-4" }, head: [0, 0.02, -0.3] },
    { name: "noon", p: { time: 720 }, head: [0, 0.02, -0.42] },
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
    await page.goto(`${origin}/?t21perf=${Date.now()}`, { waitUntil: "commit", timeout: 180000 });
    await page.bringToFront();
    await page.waitForFunction(() => window.__voyageStartup, null, { timeout: 300000, polling: 500 });
    const samplers = await page.evaluate(() => {
      const gl = window.__gl, S = [gl.SAMPLER_2D, gl.SAMPLER_3D, gl.SAMPLER_CUBE, gl.SAMPLER_2D_ARRAY, gl.SAMPLER_2D_SHADOW, gl.INT_SAMPLER_2D, gl.UNSIGNED_INT_SAMPLER_2D];
      return Math.max(...window.__progs.map((p) => {
        const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS) || 0;
        let s = 0;
        for (let i = 0; i < n; i++) if (S.includes(gl.getActiveUniform(p, i).type)) s++;
        return s;
      }));
    });
    const res = { port: origin.slice(-4), samplers, scenes: {} };
    for (const sc of SC) {
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
        v.state.turbulence = 0;
        const h = sc.head;
        Object.assign(v.head, { tx: h[0], ty: h[1], x: h[0], y: h[1], tz: h[2], z: h[2] });
        v.snapAll();
        await new Promise((r) => setTimeout(r, 2500));
      }, sc);
      const ms = [];
      await page.evaluate(() => window.__batch(5));
      for (let k = 0; k < 3; k++) ms.push(+(await page.evaluate(() => window.__batch(30))).toFixed(2));
      res.scenes[sc.name] = ms;
    }
    res.errs = await page.evaluate(() => window.__errs.slice(0, 5));
    out.push(res);
  }
  return out;
}
