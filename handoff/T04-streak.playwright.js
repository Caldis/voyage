async (page) => {
  // T13 横纹排查：同一视角下 A 正常飞行 / B 冻结前进（位移与运动向量都归零）/ C 关闭云的时间累积（每帧 reset）/ D 两者都关
  const ORIGIN = "http://127.0.0.1:5204";
  const TAG = "streak-before";
  const out = `tmp/screenshot/T04/${TAG}`;
  await page.goto(`${ORIGIN}/?t13=${Date.now()}`, { waitUntil: "commit", timeout: 180000 });
  await page.bringToFront();
  await page.waitForFunction(() => window.__voyageStartup, null, { timeout: 300000, polling: 500 });
  await page.evaluate(() => {
    const v = window.__voyage;
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
  });
  const shots = [];
  for (const [name, frz, noTaa] of [["A-fly", false, false], ["B-frozen", true, false], ["C-noTAA", false, true], ["D-frozen-noTAA", true, true]]) {
    await page.evaluate(async ([frz, noTaa]) => {
      const v = window.__voyage;
      document.getElementById("panel").classList.add("hidden");
      const set = (id, val) => {
        const el = document.getElementById(id);
        if (el.type === "checkbox") { el.checked = val; el.dispatchEvent(new Event("change")); }
        else { el.value = String(val); el.dispatchEvent(new Event(el.tagName === "SELECT" ? "change" : "input")); }
      };
      window.__frz = false;
      const p = { preset: "wpac", seat: "right", weather: "fair", "cloud-preset": "cumulus", "cabin-light": true, altitude: 10.7, shade: 0, wind: 7, "wing-pos": "-4", "ground-on": true, coverage: 0.42, time: 780 };
      for (const [id, val] of Object.entries(p)) set(id, val);
      v.state.wetness = 0;
      v.state.turbulence = 0;
      Object.assign(v.head, { tx: 0, ty: 0.16, x: 0, y: 0.16, tz: -0.12, z: -0.12 });
      v.cloudUniforms.uCloudOffset.value.set(12, 30);
      window.__frz = frz;
      window.__noTaa = noTaa;
      v.snapAll();
      await new Promise((r) => setTimeout(r, 3000));
    }, [frz, noTaa]);
    await page.screenshot({ path: `${out}/${name}.png`, timeout: 60000 });
    shots.push(name);
  }
  await page.evaluate(() => { window.__frz = false; window.__noTaa = false; });
  return { shots, vp: page.viewportSize() };
}
