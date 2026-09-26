async (page) => {
  // T13 横纹排查（二）：冻结前进，逐个替换云步进着色器里的可疑片段，同一视角截图对比
  const ORIGIN = "http://127.0.0.1:5204";
  const TAG = globalThis.__T04TAG || "ty-exp2";
  const out = `tmp/screenshot/T04/${TAG}`;
  const VARIANTS = [
    ["K0-base", []],
    ["K1-nSlod", [["vec3(u * 24.0, alt / 4.0, 0.71), max(lod - 0.5, 0.0)", "vec3(u * 24.0, alt / 4.0, 0.71), max(lod - 2.5, 0.0)"]]],
    ["K2-noS", [["0.35 * hurCap(nS.g) + 0.2 * (nS.b - 0.5)", "0.0"]]],
    ["K3-noT", [["towerAmp * hurCap(nT.g) + 1.1 * hurCap(nT.b)", "0.0"]]],
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
    const p = { preset: "wpac", seat: "right", weather: "fair", "cloud-preset": "cumulus", "cabin-light": true, altitude: 10.7, shade: 0, wind: 7, "wing-pos": "-4", "ground-on": true, coverage: 0.2, time: 540 };
    for (const [id, val] of Object.entries(p)) set(id, val);
    v.cloudUniforms.uCloudOffset.value.set(0, 0);
    set("weather", "typhoon-eye");
    window.__frz = true;
  });
  const res = [];
  for (const [name, reps, frz] of VARIANTS) {
    const r = await page.evaluate(async ([reps, frz]) => {
      window.__frz = true;
      window.__noTaa = frz === "noTaa";
      const v = window.__voyage;
      let src = window.__origFrag;
      const miss = [];
      for (const [a, b] of reps) { if (!src.includes(a)) miss.push(a); src = src.split(a).join(b); }
      v.clouds.marchMat.fragmentShader = src;
      v.clouds.marchMat.needsUpdate = true;
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      v.state.wetness = 0;
      v.state.turbulence = 0;
      Object.assign(v.head, { tx: 0, ty: 0.02, x: 0, y: 0.02, tz: -0.3, z: -0.3 });
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
