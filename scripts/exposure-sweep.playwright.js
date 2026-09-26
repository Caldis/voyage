// 曝光时间扫描（T23）：给 Playwright MCP 的 browser_run_code_unsafe 用。先打开开发服务器页面再运行。
// 在默认航线（wpac）上把当地时刻从 0 扫到 24 点（每 20 分钟，舱灯开 / 关各一遍），外加正午放下遮光板，
// 每一步 snap 后读回适应亮度（窗外、舱内按面积，cd/m²）。离线用同一套公式算舱内相对窗外的曝光差，检查是否连续、无跳变。
// 注意：文件末尾不能有分号。
async (page) => {
  await page.bringToFront();
  await page.waitForFunction(() => window.__voyageStartup, null, { timeout: 180000, polling: 500 });
  return await page.evaluate(async () => {
    const v = window.__voyage;
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
    const read = () => {
      const ex = v.exposure;
      const px = new Float32Array(4);
      ex.pass.renderer.readRenderTargetPixels(ex.adapted[0], 0, 0, 1, 1, px);
      return [+(1000 * 2 ** px[0]).toPrecision(4), +(1000 * 2 ** px[2]).toPrecision(4)];
    };
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const defaults = { preset: "wpac", seat: "right", weather: "fair", "cloud-preset": "cumulus", altitude: 10.7, shade: 0, wind: 7, "wing-pos": "8", coverage: 0.42 };
    for (const [id, val] of Object.entries(defaults)) set(id, val);
    Object.assign(v.head, { tx: 0, ty: 0.02, x: 0, y: 0.02, tz: -0.3, z: -0.3 });
    const out = { on: [], off: [], shade: [] };
    for (const light of [true, false]) {
      set("cabin-light", light);
      for (let t = 0; t <= 1440; t += 20) {
        set("time", t);
        v.snapAll();
        await wait(350);
        out[light ? "on" : "off"].push([t, ...read()]);
      }
    }
    set("cabin-light", true);
    set("time", 720);
    for (const s of [0, 0.5, 1]) {
      set("shade", s);
      v.snapAll();
      await wait(600);
      out.shade.push([s, ...read()]);
    }
    set("shade", 0);
    return out;
  });
}
