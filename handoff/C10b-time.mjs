// C10b：同页交替测云 render（步进 + resolve）的 GPU 时间。每个变体每轮：换片段 → 编译预热 → GPU 计时查询包住 N 次 clouds.render → 每帧 ms。
// 多轮交替，报每个变体的最小值 / 中位数（负载下取最小值）。
// 用法：node c10b-time.mjs --port 5235 --jobs <jobs.json> --scenes <scenes.json> --vfile <var.mjs> --variants a,b,c [--rounds 6] [--n 20]
import { createRequire } from "node:module";
import fs from "node:fs";
import { pathToFileURL } from "node:url";

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf("--" + k); return i >= 0 ? argv[i + 1] : d; };
const VOYAGE = arg("voyage", "D:/Code/opus-test/.claude/worktrees/agent-a58368fede5a4d0df/apps/voyage");
const require = createRequire(VOYAGE + "/package.json");
const { chromium } = require("playwright-core");
const { DEFAULTS, SCENES, applyScene, pinGeometry } = await import(pathToFileURL(VOYAGE + "/scripts/scenarios.mjs").href);
const { launchBrowser, closeBrowserSafely } = await import(pathToFileURL(VOYAGE + "/scripts/lib/chrome.mjs").href);
const { VARIANTS } = await import(pathToFileURL(arg("vfile")).href);
const port = arg("port", "5235");
const jobs = JSON.parse(fs.readFileSync(arg("jobs"), "utf-8"));
const extra = arg("scenes") ? JSON.parse(fs.readFileSync(arg("scenes"), "utf-8")) : [];
const VN = arg("variants").split(",");
const ROUNDS = Number(arg("rounds", "6")), N = Number(arg("n", "20"));
const log = (...a) => console.log("[c10b-time]", ...a);

function srcOf(orig, vn) {
  let s = orig;
  for (const [find, rep, optional] of VARIANTS[vn]) {
    if (!s.includes(find)) { if (optional) continue; throw new Error(`变体 ${vn} 找不到片段 ${find.slice(0, 60)}`); }
    s = s.split(find).join(rep);
  }
  return s;
}
const scOf = (j) => { const s = extra.find((x) => x.name === j.scene) ?? SCENES.find((x) => x.name === j.scene); if (!s) throw new Error("没有场景 " + j.scene); return j.offset ? { ...s, offset: j.offset } : s; };

const browser = await launchBrowser(chromium, { angle: "d3d11" });
const out = {};
try {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1200 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  page.on("console", (m) => { if (m.type() === "error" && !/eox|ERR_FAILED|CORS/i.test(m.text())) log("console.error", m.text().slice(0, 200)); });
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "commit", timeout: 180000 });
  await page.waitForFunction(() => window.__voyageStartup, null, { timeout: 300000, polling: 500 });
  await page.bringToFront();
  for (const j of jobs) {
    const sc = scOf(j);
    await page.evaluate(applyScene, { sc, defaults: DEFAULTS, settle: false });
    await page.evaluate(pinGeometry, sc);
    await page.evaluate(() => window.__voyage.freeze(true, { cloudLive: true }));
    await page.evaluate(() => new Promise((r) => setTimeout(r, 3000)));
    const orig = await page.evaluate(() => { const v = window.__voyage; return v.clouds.marchVariants.get(v.clouds.marchShown).mat.fragmentShader; });
    const res = Object.fromEntries(VN.map((v) => [v, []]));
    for (let r = 0; r < ROUNDS; r++) {
      for (const vn of VN) {
        const src = srcOf(orig, vn);
        const ms = await page.evaluate(async ({ src, N }) => {
          const v = window.__voyage;
          const m = v.clouds.marchVariants.get(v.clouds.marchShown).mat;
          if (m.fragmentShader !== src) { m.fragmentShader = src; m.needsUpdate = true; }
          const raf = () => new Promise((r) => requestAnimationFrame(r));
          const u = v.sceneMat.uniforms;
          const zero = v.clouds.resolveMat.uniforms.uMotion.value.clone().set(0, 0, 0);
          for (let i = 0; i < 6; i++) { v.clouds.render(zero, u.uCamBasis.value, u.uCabinToWorld.value); await raf(); }
          const r = v.clouds.pass.renderer;
          const gl = r.getContext();
          const ext = gl.getExtension("EXT_disjoint_timer_query_webgl2");
          const px = new Uint8Array(4);
          gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
          const q = gl.createQuery();
          gl.beginQuery(ext.TIME_ELAPSED_EXT, q);
          for (let i = 0; i < N; i++) v.clouds.render(zero, u.uCamBasis.value, u.uCabinToWorld.value);
          gl.endQuery(ext.TIME_ELAPSED_EXT);
          for (let k = 0; k < 200; k++) {
            await raf();
            if (gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) break;
          }
          const dis = gl.getParameter(ext.GPU_DISJOINT_EXT);
          const ns = gl.getQueryParameter(q, gl.QUERY_RESULT);
          gl.deleteQuery(q);
          u.uClouds.value = v.clouds.texture;
          return dis ? null : ns / 1e6 / N;
        }, { src, N });
        res[vn].push(ms);
      }
    }
    await page.evaluate((src) => { const v = window.__voyage; const m = v.clouds.marchVariants.get(v.clouds.marchShown).mat; m.fragmentShader = src; m.needsUpdate = true; v.freeze(false); }, orig);
    const row = {};
    for (const vn of VN) {
      const a = res[vn].filter((x) => x != null).sort((x, y) => x - y);
      const rat = res[vn].map((x, k) => (x != null && res[VN[0]][k] != null ? x / res[VN[0]][k] : null)).filter((x) => x != null).sort((x, y) => x - y);
      row[vn] = { min: +a[0].toFixed(3), med: +a[Math.floor(a.length / 2)].toFixed(3), n: a.length, ratio: +rat[Math.floor(rat.length / 2)].toFixed(3) };
    }
    out[j.name] = row;
    const b = row[VN[0]];
    log(j.name, VN.map((vn) => `${vn} min ${row[vn].min} med ${row[vn].med} 配对比中位 ${row[vn].ratio} (${(row[vn].min - b.min >= 0 ? "+" : "") + (row[vn].min - b.min).toFixed(3)})`).join(" | "));
  }
} finally {
  if (arg("out")) fs.writeFileSync(arg("out"), JSON.stringify(out, null, 2));
  await closeBrowserSafely(browser);
}
