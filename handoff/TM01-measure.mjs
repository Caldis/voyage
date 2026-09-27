// TM01：同一页面、同一冻结姿态下对照曝光 / 色调映射 uniform（改自 handoff/C01-measure.mjs，只换曝光参数时不用重编云）
// 两种模式：
//   默认（--avg）：真平均累积 64 帧再截（与 C01 的 int_c 同口径；变体可带 march 补丁，如 C01 的 old）
//   --live：冻结后不累积，直接截实时那一帧（棋盘纹 / 相邻像素差按 SOP 测量约定用它）；所有变体共用同一份云缓冲，不能带 march 补丁
// 用法：node handoff/TM01-measure.mjs --port 5216 --vfile handoff/TM01-ab.mjs --scenes a,b [--variants x,y] [--live] [--no-bin] --out <绝对路径>
//   输出 <out>/<场景>/<变体>.png（.bin = 云缓冲，仅 avg 模式）、meta.json（适应结果）
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const VOYAGE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..").replace(/\\/g, "/");
const require = createRequire(VOYAGE + "/package.json");
const { chromium } = require("playwright-core");
const { DEFAULTS, SCENES, applyScene } = await import(pathToFileURL(VOYAGE + "/scripts/scenarios.mjs").href);
const { launchBrowser, closeBrowserSafely } = await import(pathToFileURL(VOYAGE + "/scripts/lib/chrome.mjs").href);

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => (a.startsWith("--") ? [...acc, [a.slice(2), arr[i + 1] && !arr[i + 1].startsWith("--") ? arr[i + 1] : true]] : acc), []),
);
const port = args.port || 5216;
const live = !!args.live;
const OUT = args.out || "D:/Code/opus-test/tmp/screenshot/tm01/x";
const { VARIANTS } = await import(pathToFileURL(path.resolve(args.vfile)).href);

const EXTRA = {
  "backlit-cu": { name: "backlit-cu", p: { preset: "wpac", time: 1010, altitude: 4, coverage: 0.5, "wing-pos": "-4" } },
  "cu-side": { name: "cu-side", p: { preset: "wpac", time: 840, altitude: 4.5, coverage: 0.5, "cloud-preset": "towering", "wing-pos": "-4" } },
  "biz-behind": { name: "biz-behind", p: { preset: "wpac", time: 720, "wing-pos": "8", "cabin-class": "business" }, head: [0.42, 0.1, -0.5] },
};
const sceneList = String(args.scenes || "noon-cumulus").split(",").map((n) => EXTRA[n] || SCENES.find((s) => s.name === n));
if (sceneList.some((s) => !s)) throw new Error("有场景名不认识");
const wanted = args.variants ? String(args.variants).split(",") : Object.keys(VARIANTS);

const browser = await launchBrowser(chromium, { angle: args.angle || "d3d11" });
const log = (...a) => console.log("[tm01]", ...a);
let errors = 0;
try {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1200 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => (errors++, log("pageerror", e.message)));
  page.on("console", (m) => { if (m.type() === "error") errors++; if (m.type() === "error" || m.type() === "warning") log("console." + m.type(), m.text().slice(0, 300)); });
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
    window.__tm = {
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
        for (const [k] of Object.entries(vals || {})) {
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
      async settleExposure() { v.exposure.snap(); await this.frames(4); },
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
        return { b64: btoa(s) };
      },
    };
  });

  for (const sc of sceneList) {
    const dir = path.join(OUT, sc.name);
    fs.mkdirSync(dir, { recursive: true });
    const info = await page.evaluate(applyScene, { sc, defaults: DEFAULTS, settle: !!sc.ground });
    await page.evaluate(() => window.__voyage.quality.setTier("high"));
    await page.evaluate(() => window.__voyage.snapAll());
    await page.waitForTimeout(sc.wait ? Math.max(1500, sc.wait / 2) : 1500);
    if (sc.ground) await page.waitForFunction(() => window.__voyage.ground.pending === 0, null, { timeout: 60000, polling: 500 }).catch(() => log("地面瓦片未等齐"));
    await page.evaluate(() => window.__voyage.freeze(true));
    await page.evaluate(() => window.__tm.frames(3));
    const meta = { scene: sc.name, live, info: String(info).replace(/\n/g, " | "), key: await page.evaluate(() => window.__tm.shownKey()), variants: {} };
    for (const vn of wanted) {
      const V = VARIANTS[vn];
      if (!V) { log("没有变体", vn); continue; }
      if (live && V.march?.length) { log("live 模式跳过带 march 补丁的变体", vn); continue; }
      const changed = await page.evaluate((p) => window.__tm.patch(p), V.march || []);
      if (changed) await page.evaluate(() => window.__tm.compile());
      await page.evaluate((e) => window.__tm.setExp(e), V.exp || {});
      if (live) await page.evaluate(() => window.__tm.settleExposure());
      else await page.evaluate(() => window.__tm.accumulate(64));
      await page.screenshot({ path: path.join(dir, vn + ".png") });
      if (!live && !args["no-bin"]) {
        const r = await page.evaluate(() => window.__tm.readCloud(0, 0, 1600, 1200)).catch((e) => ({ err: e.message }));
        if (r.b64) fs.writeFileSync(path.join(dir, vn + ".bin"), Buffer.from(r.b64, "base64"));
      }
      const ad = await page.evaluate(() => window.__tm.readAdapted());
      meta.variants[vn] = { adapted: ad };
      log(sc.name, vn, "适应", JSON.stringify(ad.slice(0, 4)));
    }
    await page.evaluate(() => window.__tm.patch([]));
    await page.evaluate(() => window.__tm.setExp({}));
    await page.evaluate(() => window.__voyage.freeze(false));
    fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify(meta, null, 2));
  }
  log("console error / pageerror 数", errors);
} finally {
  await closeBrowserSafely(browser);
}
