// 舱内 / 窗外亮度统计（T23）：给 Playwright MCP 的 browser_run_code_unsafe 用（filename 参数指向本文件）。
// 用法：先打开要测的开发服务器，URL 里带 tag，例如 http://127.0.0.1:5223/?tag=before，再运行本文件；
// 每个场景截两张图到 tmp/screenshot/T23/<tag>/：<场景>.png（正常画面）和 <场景>-mask.png（窗外遮罩，白 = 窗外），
// 并返回各场景的适应亮度（cd/m²）。然后跑 `python apps/voyage/scripts/cabin_luminance.py tmp/screenshot/T23/<tag>` 出亮度表。
// 注意：工具会把文件内容包成「(内容)(page)」执行，文件末尾不能有分号。
async (page) => {
  const current = page.url();
  const origin = (current.match(/^http:\/\/127\.0\.0\.1:5\d\d\d/) || ["http://127.0.0.1:5181"])[0];
  const tag = (current.match(/[?&]tag=([\w-]+)/) || [null, "run"])[1];
  const outDir = `tmp/screenshot/T23/${tag}`;

  const SCENES = [
    { name: "noon-cumulus", p: { preset: "wpac", time: 720, "wing-pos": "8" } },
    { name: "sunset-wing", p: { preset: "wpac", time: 1040, "wing-pos": "8" } },
    { name: "dusk-earthshadow", p: { preset: "wpac", seat: "left", time: 1068, "wing-pos": "-4" } },
    { name: "in-cloud", p: { preset: "wpac", time: 840, "cloud-preset": "stratocumulus", coverage: 0.95, altitude: 1.35, "wing-pos": "8" }, wait: 6000 },
    { name: "night-city", p: { preset: "fuji", time: 1260, altitude: 4, coverage: 0.15, "cabin-light": false }, offset: [0, -25], ground: true, head: -0.25 },
    { name: "night-city-light", p: { preset: "fuji", time: 1260, altitude: 4, coverage: 0.15, "cabin-light": true }, offset: [0, -25], ground: true, head: -0.25 },
  ];

  await page.goto(`${origin}/?t23=${Date.now()}`, { waitUntil: "commit", timeout: 180000 });
  await page.bringToFront();
  await page.waitForFunction(() => window.__voyageStartup, null, { timeout: 180000, polling: 500 });

  const results = [];
  for (const sc of SCENES) {
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
      const defaults = { preset: "wpac", seat: "right", weather: "fair", "cloud-preset": "cumulus", "cabin-light": true, altitude: 10.7, shade: 0, wind: 7, "wing-pos": "8", "ground-on": true };
      for (const [id, val] of Object.entries({ ...defaults, ...sc.p })) set(id, val);
      if (sc.p.coverage === undefined) set("coverage", 0.42);
      if (sc.p.time !== undefined) set("time", sc.p.time);
      v.state.wetness = 0;
      v.state.turbulence = 0.03;
      const hz = sc.head ?? -0.3;
      Object.assign(v.head, { tx: 0, ty: 0.02, x: 0, y: 0.02, tz: hz, z: hz });
      if (sc.offset) v.cloudUniforms.uCloudOffset.value.set(sc.offset[0], sc.offset[1]);
      if (sc.p.weather) set("weather", sc.p.weather);
      if (sc.ground) {
        for (let i = 0; i < 40; i++) {
          await new Promise((r) => setTimeout(r, 1000));
          if (v.ground.pending < 5 && i > 5) break;
        }
      }
      v.snapAll();
      await new Promise((r) => setTimeout(r, sc.wait ?? 2500));
      // 适应亮度：exposure.adapted[0] 是最近一帧写入的 1×1 目标（rgb = 窗外、舱内（中心加权）、舱内（按面积）的 log2 亮度，单位 kcd/m²）
      const ex = v.exposure;
      const px = new Float32Array(4);
      ex.pass.renderer.readRenderTargetPixels(ex.adapted[0], 0, 0, 1, 1, px);
      const cd = (x) => +(1000 * 2 ** x).toPrecision(4);
      // 旧版（改前）只有 rg 两路；新版 b 是按面积平均的舱内亮度
      return { outCd: cd(px[0]), cabinCenterCd: cd(px[1]), cabinAreaCd: cd(px[2]), uLegacy: ex.finalMat.uniforms.uLegacy?.value ?? null };
    }, sc);
    await page.screenshot({ path: `${outDir}/${sc.name}.png`, timeout: 60000 });
    await page.evaluate(() => (window.__voyage.exposure.finalMat.uniforms.uDebugMask.value = true));
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${outDir}/${sc.name}-mask.png`, timeout: 60000 });
    await page.evaluate(() => (window.__voyage.exposure.finalMat.uniforms.uDebugMask.value = false));
    results.push({ scene: sc.name, ...info });
  }
  return { origin, tag, results }
}
