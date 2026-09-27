// C01 / C02：同一页面、同一冻结姿态下对照云步进补丁 + 曝光参数（改自 tmp/cloud-sharp/csharp-measure.mjs）
// 每个变体：页面内替换「实际在画的」云步进变体片段 + 设曝光 uniform → 真平均累积 64 帧 → 曝光 snap → 截图 + 云缓冲 + 适应结果
// 用法：node handoff/C01-measure.mjs --port 5215 --vfile handoff/C01-ab.mjs --scenes noon-cumulus,clouds-variety,backlit-cu \
//         [--variants old,new] [--angle vulkan] [--no-bin] --out <绝对路径>
//   变体文件导出 VARIANTS = { 名字: { march: [[查找, 替换], ...], exp: { 曝光 uniform: 值 } } }；场景另认 backlit-cu / cu-side（研究报告的两个）
//   输出：<out>/<场景>/<变体>.png、.bin（云缓冲 1600×1200 RGBA float32）、meta.json（含适应结果 o / c / h）；指标见 C01-metrics.py
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { fileURLToPath } from "node:url";
const VOYAGE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..").replace(/\\/g, "/");
const require = createRequire(VOYAGE + "/package.json");
const { chromium } = require("playwright-core");
const { DEFAULTS, SCENES, applyScene } = await import(pathToFileURL(VOYAGE + "/scripts/scenarios.mjs").href);
const { launchBrowser, closeBrowserSafely } = await import(pathToFileURL(VOYAGE + "/scripts/lib/chrome.mjs").href);

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => (a.startsWith("--") ? [...acc, [a.slice(2), arr[i + 1] && !arr[i + 1].startsWith("--") ? arr[i + 1] : true]] : acc), []),
);
const port = args.port || 5215;
const angle = args.angle || "d3d11";
const OUT = args.out || "D:/Code/opus-test/tmp/screenshot/c01/x";
const { VARIANTS } = await import(pathToFileURL(path.resolve(args.vfile)).href);

const EXTRA = {
  "backlit-cu": { name: "backlit-cu", p: { preset: "wpac", time: 1010, altitude: 4, coverage: 0.5, "wing-pos": "-4" } },
  "cu-side": { name: "cu-side", p: { preset: "wpac", time: 840, altitude: 4.5, coverage: 0.5, "cloud-preset": "towering", "wing-pos": "-4" } },
};
// --offset x,y（C03 加）：没写 offset 的场景用这个云偏移，跨次运行取景一致（否则飞机从打开页面起一直在飞，云的位置每次不同）
const OFFSET = args.offset ? String(args.offset).split(",").map(Number) : null;
const sceneList = String(args.scenes || "noon-cumulus").split(",").map((n) => EXTRA[n] || SCENES.find((s) => s.name === n))
  .map((s) => (OFFSET && !s.offset ? { ...s, offset: OFFSET } : s));
const wanted = args.variants ? String(args.variants).split(",") : Object.keys(VARIANTS);

const browser = await launchBrowser(chromium, { angle });
const log = (...a) => console.log("[c01]", ...a);
try {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1200 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => log("pageerror", e.message));
  page.on("console", (m) => (m.type() === "error" || m.type() === "warning") && log("console." + m.type(), m.text().slice(0, 300)));
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "commit", timeout: 180000 });
  await page.waitForFunction(() => window.__voyageStartup, null, { timeout: 300000, polling: 500 });
  await page.bringToFront();

  await page.evaluate(() => {
    const v = window.__voyage;
    const rm = v.clouds.resolveMat;
    rm.uniforms.uCsBlend = { value: 0.12 };
    rm.uniforms.uCsClamp = { value: 1 };
    rm.fragmentShader = rm.fragmentShader.replace("uniform bool uReset;", "uniform bool uReset; uniform float uCsBlend; uniform float uCsClamp;").replace("float blend = 0.12;", "float blend = uCsBlend;")
      .replace("vec4 hist = clamp(texture(uHistory, vec2(hx / (2.0 * uCloudResolution.x), puv.y)), mn, mx);", "vec4 hraw = texture(uHistory, vec2(hx / (2.0 * uCloudResolution.x), puv.y)); vec4 hist = mix(hraw, clamp(hraw, mn, mx), uCsClamp);");
    if (!rm.fragmentShader.includes("uCsClamp)") || !rm.fragmentShader.includes("blend = uCsBlend")) throw new Error("resolve 补丁失败");
    rm.needsUpdate = true;
    const orig = new Map();
    const expOrig = new Map();
    const raf = () => new Promise((r) => requestAnimationFrame(r));
    const shownMat = () => v.clouds.marchVariants.get(v.clouds.marchShown).mat;
    window.__cs = {
      raf,
      async frames(n) { for (let i = 0; i < n; i++) await raf(); },
      shownKey: () => v.clouds.marchShown,
      patch(pairs) {
        const m = shownMat();
        if (!orig.has(m)) orig.set(m, m.fragmentShader);
        let s = orig.get(m);
        for (const [a, b] of pairs) {
          if (!s.includes(a)) throw new Error("找不到：" + a.slice(0, 100));
          s = s.split(a).join(b);
        }
        if (m.fragmentShader !== s) { m.fragmentShader = s; m.needsUpdate = true; return true; }
        return false;
      },
      setExp(vals) {
        const u = v.exposure.finalMat.uniforms;
        for (const [k, val] of Object.entries(vals || {})) {
          if (!u[k]) throw new Error("没有曝光 uniform " + k);
          if (!expOrig.has(k)) expOrig.set(k, u[k].value?.clone ? u[k].value.clone() : u[k].value);
        }
        for (const [k, o] of expOrig) {
          const val = vals && k in vals ? vals[k] : null;
          if (val === null) { if (u[k].value?.copy) u[k].value.copy(o); else u[k].value = o; }
          else if (Array.isArray(val)) u[k].value.fromArray(val);
          else u[k].value = val;
        }
      },
      async compile() {
        const renderer = v.clouds.pass.renderer, p = v.clouds.pass;
        const prevM = p.mesh.material, prevT = renderer.getRenderTarget();
        p.mesh.material = shownMat();
        renderer.setRenderTarget(v.clouds.raw);
        await renderer.compileAsync(p.scene, p.camera);
        p.mesh.material = prevM;
        renderer.setRenderTarget(prevT);
        const prog = renderer.properties.get(shownMat()).currentProgram;
        prog?.getUniforms();
        if (!prog || prog.diagnostics?.runnable === false) throw new Error("补丁后的云步进编译失败");
      },
      async accumulate(n) {
        const u = v.sceneMat.uniforms;
        const zero = v.clouds.resolveMat.uniforms.uMotion.value.clone().set(0, 0, 0);
        v.clouds.snap();
        const bl = v.clouds.resolveMat.uniforms.uCsBlend, cl = v.clouds.resolveMat.uniforms.uCsClamp;
        cl.value = 0;
        for (let i = 0; i < n; i++) { bl.value = 1 / (i + 1); v.clouds.render(zero, u.uCamBasis.value, u.uCabinToWorld.value); }
        bl.value = 0.12; cl.value = 1;
        u.uClouds.value = v.clouds.texture;
        await this.frames(2);
        v.exposure.snap();
        await this.frames(4);
      },
      readAdapted() {
        const t = v.exposure.adapted[0];
        const buf = new Float32Array(8);
        v.clouds.pass.renderer.readRenderTargetPixels(t, 0, 0, 2, 1, buf);
        return Array.from(buf).map((x) => +x.toFixed(3));
      },
      readCloud(x, y, w, h) {
        const t = v.clouds.history[0];
        const buf = new Float32Array(w * h * 4);
        v.clouds.pass.renderer.readRenderTargetPixels(t, x, y, w, h, buf);
        const bytes = new Uint8Array(buf.buffer);
        let s = "";
        for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
        return { b64: btoa(s), W: t.width / 2, H: t.height };
      },
    };
  });

  for (const sc of sceneList) {
    const dir = path.join(OUT, sc.name);
    fs.mkdirSync(dir, { recursive: true });
    const info = await page.evaluate(applyScene, { sc, defaults: DEFAULTS, settle: !!sc.ground });
    await page.evaluate(() => window.__voyage.quality.setTier("high"));
    await page.evaluate(() => window.__voyage.snapAll());
    await page.waitForTimeout(1500);
    await page.evaluate(() => window.__voyage.freeze(true));
    await page.evaluate(() => window.__cs.frames(3));
    const meta = { scene: sc.name, info: info.replace(/\n/g, " | "), key: await page.evaluate(() => window.__cs.shownKey()), variants: {} };
    for (const vn of wanted) {
      const V = VARIANTS[vn];
      if (!V) { log("没有变体", vn); continue; }
      const t0 = Date.now();
      const changed = await page.evaluate((p) => window.__cs.patch(p), V.march || []);
      if (changed) await page.evaluate(() => window.__cs.compile());
      await page.evaluate((e) => window.__cs.setExp(e), V.exp || {});
      await page.evaluate(() => window.__cs.accumulate(64));
      await page.screenshot({ path: path.join(dir, vn + ".png") });
      if (!args["no-bin"]) {
        const r = await page.evaluate(() => window.__cs.readCloud(0, 0, 1600, 1200)).catch((e) => ({ err: e.message }));
        if (r.b64) fs.writeFileSync(path.join(dir, vn + ".bin"), Buffer.from(r.b64, "base64"));
      }
      const ad = await page.evaluate(() => window.__cs.readAdapted());
      meta.variants[vn] = { adapted: ad, ms: Date.now() - t0 };
      log(sc.name, vn, "适应", JSON.stringify(ad.slice(0, 4)), Date.now() - t0, "ms");
    }
    await page.evaluate(() => window.__cs.patch([]));
    await page.evaluate(() => window.__cs.setExp({}));
    await page.evaluate(() => window.__voyage.freeze(false));
    fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify(meta, null, 2));
  }
} finally {
  await closeBrowserSafely(browser);
}
