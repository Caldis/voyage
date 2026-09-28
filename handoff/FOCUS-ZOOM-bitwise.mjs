// FOCUS-ZOOM：不聚焦时逐位不变的核对。
//   node apps/voyage/handoff/FOCUS-ZOOM-bitwise.mjs [--port 5264]
// ① 云 resolve：同一页面、全冻结，按确定性序列（uFrame 从 0 起、静止 + 巡航各 64 帧）渲染，读回整张 history（颜色 + 深度两半），
//    本分支 resolve（uPrevTanHalfFov + 视场变化压帧数）与把那一行换回 master 写法（/ uTanHalfFov、不压帧数）的版本逐位比较；
// ② 主循环：不聚焦时写进 uTanHalfFov 的值与 master 的常数 Math.tan(25°) 逐位相同；场景表里所有 head 在限位内（限位不改头部位置）。
import { chromium } from "playwright-core";
import { launchBrowser, closeBrowserSafely } from "../scripts/lib/chrome.mjs";
import { DEFAULTS, SCENES, applyScene, pinGeometry } from "../scripts/scenarios.mjs";

const port = process.argv.includes("--port") ? process.argv[process.argv.indexOf("--port") + 1] : 5264;
const browser = await launchBrowser(chromium, { angle: "d3d11" });
try {
  const page = await (await browser.newContext({ viewport: { width: 1600, height: 1200 } })).newPage();
  await page.goto(`http://127.0.0.1:${port}/?t=${Date.now()}&voyage=0`, { waitUntil: "commit", timeout: 180000 });
  await page.waitForFunction(() => window.__voyageStartup, null, { timeout: 180000, polling: 500 });
  for (const name of ["sea-sc", "noon-cumulus"]) {
    const sc = SCENES.find((s) => s.name === name);
    await page.evaluate(applyScene, { sc, defaults: DEFAULTS, settle: false });
    await page.evaluate(pinGeometry, sc);
    await page.evaluate(() => window.__voyage.freeze(true));
    const r = await page.evaluate(async () => {
      const v = window.__voyage, c = v.clouds, u = v.sceneMat.uniforms, R = c.resolveMat;
      const src = R.fragmentShader;
      const masterSrc = src.replace("v.xy / (-v.z) / uPrevTanHalfFov;", "v.xy / (-v.z) / uTanHalfFov;");
      if (masterSrc === src) return { err: "没找到要换回的那一行" };
      const t = c.history[0];
      const run = (speed) => {
        c.frame = 0;
        c.snap();
        const off0 = v.cloudUniforms.uCloudOffset.value.clone();
        const m = R.uniforms.uMotion.value.clone().set(0.6 * speed, 0, -0.8 * speed);
        for (let k = 0; k < 64; k++) {
          v.cloudUniforms.uCloudOffset.value.set(off0.x + 0.6 * speed * k, off0.y - 0.8 * speed * k);
          c.render(m, u.uCamBasis.value, u.uCabinToWorld.value);
        }
        v.cloudUniforms.uCloudOffset.value.copy(off0);
        const buf = new Float32Array(t.width * t.height * 4);
        c.pass.renderer.readRenderTargetPixels(c.history[0], 0, 0, t.width, t.height, buf);
        return buf;
      };
      const out = {};
      for (const speed of [0, 0.004]) {
        c.zoomSinceResetCap = 8;
        const a = run(speed);
        R.fragmentShader = masterSrc;
        R.needsUpdate = true;
        c.zoomSinceResetCap = Infinity;
        const b = run(speed);
        R.fragmentShader = src;
        R.needsUpdate = true;
        c.zoomSinceResetCap = 8;
        const a2 = run(speed);
        let diff = 0, diffAA = 0, diffB2 = 0;
        const ia = new Uint32Array(a.buffer), ib = new Uint32Array(b.buffer), ia2 = new Uint32Array(a2.buffer);
        for (let i = 0; i < ia.length; i++) { if (ia[i] !== ib[i]) diff++; if (ia[i] !== ia2[i]) diffAA++; if (ib[i] !== ia2[i]) diffB2++; }
        out[speed ? "巡航" : "静止"] = { 浮点数: ia.length, 与master写法不同: diff, 同代码两次不同: diffAA, master写法与第二次本分支不同: diffB2 };
      }
      u.uClouds.value = c.texture;
      return out;
    });
    console.log(`${name} 云 resolve 逐位：${JSON.stringify(r)}`);
    await page.evaluate(() => window.__voyage.freeze(false));
  }
  const m = await page.evaluate(async (scenes) => {
    const v = window.__voyage;
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const same = v.sceneMat.uniforms.uTanHalfFov.value === Math.tan((25 * Math.PI) / 180);
    // 场景表里的 head 与各视角预设：限位不改动它们（在各自的舱等 / 座位下核对）
    const bad = [];
    for (const sc of scenes) {
      if (!Array.isArray(sc.head)) continue;
      const [x, y, z] = sc.head;
      const q = { y, z, tanHalfFov: Math.tan((25 * Math.PI) / 180), aspect: 1600 / 1200, seatSign: (sc.p.seat ?? "right") === "right" ? 1 : -1, economy: sc.p["cabin-class"] === "economy" };
      const L = new v.headLimits.constructor();
      L.update(q);
      if (L.clamp(x) !== x) bad.push(sc.name);
    }
    return { tanSame: same, headsClamped: bad };
  }, SCENES);
  console.log(`主循环：不聚焦时 uTanHalfFov 与 master 常数逐位相同 = ${m.tanSame}；场景表 head 被限位改动的场景：${m.headsClamped.length ? m.headsClamped.join(", ") : "无"}`);
} finally {
  await closeBrowserSafely(browser);
}
