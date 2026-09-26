async (page) => {
  // T13 横纹排查（二）：冻结前进，逐个替换云步进着色器里的可疑片段，同一视角截图对比
  const ORIGIN = "http://127.0.0.1:5204";
  const TAG = "streak-exp3";
  const out = `tmp/screenshot/T04/${TAG}`;
  const WARP = ["w.warp = (vec2(w2.b, w1.a) - 0.5) * 3.0;", "w.warp = (vec2(w1.b, w3.r) - 0.5) * 2.0;"];
  const STEP = [
    ["vec3 p = ro + rd * (t + dt * jitter);", "float stepLen = (fine > 0 || !wasEmpty) ? dt : 2.0 * dt;\n    vec3 p = ro + rd * (t + stepLen * jitter);"],
    ["float stepT = exp(-sigma * dt);", "float stepT = exp(-sigma * stepLen);"],
    ["      t += dt;\n    } else {", "      t += stepLen;\n    } else {"],
    ["t += fine > 0 ? dt : 2.0 * dt;", "t += stepLen;"],
  ];
  const VARIANTS = [
    ["F0-base", []],
    ["F1-warp", [WARP]],
    ["F2-warp-step", [WARP, ...STEP]],
    ["F2-fly", [WARP, ...STEP], false],
    ["F0-fly", [], false],
  ];
  if (!page.url().startsWith(ORIGIN)) {
    await page.goto(`${ORIGIN}/?t13=${Date.now()}`, { waitUntil: "commit", timeout: 180000 });
  }
  await page.bringToFront();
  await page.waitForFunction(() => window.__voyageStartup, null, { timeout: 300000, polling: 500 });
  await page.evaluate(() => {
    const v = window.__voyage;
    if (window.__patched) return;
    window.__patched = true;
    const o = v.cloudUniforms.uCloudOffset.value;
    let X = o.x, Y = o.y;
    Object.defineProperty(o, "x", { get: () => X, set: (n) => { if (!window.__frz) X = n; }, configurable: true });
    Object.defineProperty(o, "y", { get: () => Y, set: (n) => { if (!window.__frz) Y = n; }, configurable: true });
    const orig = v.clouds.render.bind(v.clouds);
    v.clouds.render = (m, a, b) => {
      if (window.__frz) m.set(0, 0, 0);
      if (window.__noTaa) v.clouds.reset = true;
      return orig(m, a, b);
    };
    window.__origFrag = v.clouds.marchMat.fragmentShader;
    const set = (id, val) => {
      const el = document.getElementById(id);
      if (el.type === "checkbox") { el.checked = val; el.dispatchEvent(new Event("change")); }
      else { el.value = String(val); el.dispatchEvent(new Event(el.tagName === "SELECT" ? "change" : "input")); }
    };
    document.getElementById("panel").classList.add("hidden");
    const p = { preset: "wpac", seat: "right", weather: "fair", "cloud-preset": "cumulus", "cabin-light": true, altitude: 10.7, shade: 0, wind: 7, "wing-pos": "-4", "ground-on": true, coverage: 0.42, time: 780 };
    for (const [id, val] of Object.entries(p)) set(id, val);
    v.cloudUniforms.uCloudOffset.value.set(12, 30);
    window.__frz = true;
  });
  const res = [];
  for (const [name, reps, frz] of VARIANTS) {
    const r = await page.evaluate(async ([reps, frz]) => {
      window.__frz = frz !== false;
      const v = window.__voyage;
      let src = window.__origFrag;
      const miss = [];
      for (const [a, b] of reps) { if (!src.includes(a)) miss.push(a); src = src.split(a).join(b); }
      v.clouds.marchMat.fragmentShader = src;
      v.clouds.marchMat.needsUpdate = true;
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      v.state.wetness = 0;
      v.state.turbulence = 0;
      Object.assign(v.head, { tx: 0, ty: 0.1, x: 0, y: 0.1, tz: -0.2, z: -0.2 });
      v.snapAll();
      await new Promise((r) => setTimeout(r, 3000));
      return { miss, pitch: v.state.pitchDeg, alt: v.state.altitudeKm };
    }, [reps, frz]);
    await page.screenshot({ path: `${out}/${name}.png`, timeout: 60000 });
    res.push({ name, ...r });
  }
  await page.evaluate(() => { const v = window.__voyage; v.clouds.marchMat.fragmentShader = window.__origFrag; v.clouds.marchMat.needsUpdate = true; window.__frz = false; });
  return res;
}
