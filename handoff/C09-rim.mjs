// C09 逆光银边：同页 A/B（云步进片段替换）+ 实时路径 + 从云缓冲读 HDR 银边指标。改自 handoff/C03-rt.mjs（审查的实时路径）。
// 用法：
//   找机位：node handoff/C09-rim.mjs --port 5209 --find --scene backlit-close [--grid -12,12,1.5]
//     按场景的 date / time / 座位把太阳摆到窗中央（打印航向），再扫云偏移，找「太阳被一团积云挡住、云边离太阳 3–8°」的偏移
//   测变体：node handoff/C09-rim.mjs --port 5209 --vfile handoff/C09-var.mjs --scenes backlit-close,noon-cumulus \
//            [--variants base,wide] [--crop 420,300,760,700] --out <绝对路径>
//     每个变体：页面内替换云步进片段 → 实时路径（blend 0.12 + 邻域夹取，预热 96 帧、逐帧读 128 帧：relStd / relLow16）→
//     稳态单帧截图 <out>/<场景>/<变体>.png → 读整张云缓冲算指标（打印 + meta.json）：
//       cloud：不透明度 α > 0.5 的像素的「云自身亮度」c = Y(L) / α 的均值（云缓冲不含背景，L 是预乘的，除以 α 就没有背景混进来）
//       rim（太阳在视野里时）：离太阳 ≤ 15° 的像素里，边（α 0.2–0.7）的 c 均值 ÷ 芯（α ≥ 0.97）的 c 均值；另给 3–8° 环带内的同一比值
//       d：相对第一个变体的逐像素变化（|ΔY| 均值 / Y 均值，云像素），看顺光 / 侧光场景外观变没变
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
const port = args.port || 5209;
const OUT = args.out || "D:/Code/opus-test/tmp/screenshot/c09/x";
const EXTRA = {
  "cu-side": { name: "cu-side", p: { preset: "wpac", time: 840, altitude: 4.5, coverage: 0.5, "cloud-preset": "towering", "wing-pos": "-4" }, offset: [0, 0] },
  "backlit-cu": { name: "backlit-cu", p: { preset: "wpac", time: 1010, altitude: 4, coverage: 0.5, "wing-pos": "-4" }, offset: [0, 0] },
};
const OFFSET = args.offset ? String(args.offset).split(",").map(Number) : null;
// --offset x,y：覆盖场景的云偏移（找机位时逐个看候选）
const findScene = (n) => { const s = EXTRA[n] || SCENES.find((x) => x.name === n); return OFFSET ? { ...s, offset: OFFSET } : s; };
const log = (...a) => console.log("[c09]", ...a);

const browser = await launchBrowser(chromium, { angle: args.angle || "d3d11" });
try {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1200 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => log("pageerror", e.message));
  page.on("console", (m) => m.type() === "error" && log("console.error", m.text().slice(0, 300)));
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
    const raf = () => new Promise((r) => requestAnimationFrame(r));
    const shownMat = () => v.clouds.marchVariants.get(v.clouds.marchShown).mat;
    const U = () => v.sceneMat.uniforms;
    window.__cs = {
      raf,
      async frames(n) { for (let i = 0; i < n; i++) await raf(); },
      shownKey: () => v.clouds.marchShown,
      // 视线几何：太阳方向在屏幕上的位置（全分辨率像素，原点左下）与相机矩阵，给 node 算每个云像素离太阳多少度
      geom() {
        const u = U();
        const kd = (u.uKeyDir || v.cloudUniforms.uKeyDir || { value: v.clouds.keyDir }).value;
        return { cam: u.uCamBasis.value.elements.slice(), c2w: u.uCabinToWorld.value.elements.slice(), tan: u.uTanHalfFov.value,
          res: [u.uResolution.value.x, u.uResolution.value.y], key: [kd.x, kd.y, kd.z], heading: v.state.heading, sunAlt: v.sunAltDeg() };
      },
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
      // 找机位用：真平均 n 帧（blend 1/(i+1)、不夹取）
      accumulate(n) {
        const u = U();
        const zero = v.clouds.resolveMat.uniforms.uMotion.value.clone().set(0, 0, 0);
        v.clouds.snap();
        const bl = v.clouds.resolveMat.uniforms.uCsBlend, cl = v.clouds.resolveMat.uniforms.uCsClamp;
        cl.value = 0;
        for (let i = 0; i < n; i++) { bl.value = 1 / (i + 1); v.clouds.render(zero, u.uCamBasis.value, u.uCabinToWorld.value); }
        bl.value = 0.12; cl.value = 1;
      },
      // 真实实时路径（blend 0.12 + 邻域夹取），静止相机；预热 warm 帧后逐帧读裁剪区亮度，统计时间波动（同 C03-rt）
      async realtime(warm, nSeries, crop) {
        const u = U();
        const zero = v.clouds.resolveMat.uniforms.uMotion.value.clone().set(0, 0, 0);
        v.clouds.snap();
        const bl = v.clouds.resolveMat.uniforms.uCsBlend, cl = v.clouds.resolveMat.uniforms.uCsClamp;
        bl.value = 0.12; cl.value = 1;
        v.clouds.frame = 0;
        for (let i = 0; i < warm; i++) v.clouds.render(zero, u.uCamBasis.value, u.uCabinToWorld.value);
        const CW = v.clouds.history[0].width / 2, CH = v.clouds.history[0].height, sx = CW / 1600, sy = CH / 1200;
        const x = Math.round(crop[0] * sx), w = Math.round(crop[2] * sx), h = Math.round(crop[3] * sy), y = Math.round(CH - (crop[1] + crop[3]) * sy);
        const N = w * h;
        const series = [];
        const buf = new Float32Array(N * 4);
        for (let f = 0; f < nSeries; f++) {
          v.clouds.render(zero, u.uCamBasis.value, u.uCabinToWorld.value);
          v.clouds.pass.renderer.readRenderTargetPixels(v.clouds.history[0], x, y, w, h, buf);
          const L = new Float32Array(N);
          for (let k = 0; k < N; k++) L[k] = 0.2126 * buf[4 * k] + 0.7152 * buf[4 * k + 1] + 0.0722 * buf[4 * k + 2];
          series.push(L);
        }
        let sStd = 0, sLow = 0, sMean = 0, cnt = 0;
        const B = 16;
        for (let k = 0; k < N; k++) {
          let m = 0; for (let f = 0; f < nSeries; f++) m += series[f][k]; m /= nSeries;
          if (m < 0.02) continue;
          let s2 = 0; for (let f = 0; f < nSeries; f++) s2 += (series[f][k] - m) ** 2;
          let l2 = 0, nb = 0;
          for (let f0 = 0; f0 + B <= nSeries; f0 += B) { let a = 0; for (let f = f0; f < f0 + B; f++) a += series[f][k]; a /= B; l2 += (a - m) ** 2; nb++; }
          sStd += Math.sqrt(s2 / nSeries) / m; sLow += Math.sqrt(l2 / nb) / m; sMean += m; cnt++;
        }
        u.uClouds.value = v.clouds.texture;
        await this.frames(2);
        v.exposure.snap();
        await this.frames(4);
        return { px: cnt, relStd: +(sStd / cnt).toFixed(4), relLow16: +(sLow / cnt).toFixed(4), mean: +(sMean / cnt).toFixed(3) };
      },
      // full：连右半（深度 × 不透明度, 不透明度）一起读（找机位时临时打开深度半边，见 --find）
      readCloud(full) {
        const t = v.clouds.history[0];
        const W = full ? t.width : t.width / 2, H = t.height;
        const buf = new Float32Array(W * H * 4);
        v.clouds.pass.renderer.readRenderTargetPixels(t, 0, 0, W, H, buf);
        const bytes = new Uint8Array(buf.buffer);
        let s = "";
        for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
        return { b64: btoa(s), W, H };
      },
    };
  });

  // 每个云像素离太阳的角度（度）；cam / c2w 是 three 的 Matrix3（列主序）
  const angleMap = (g, W, H) => {
    const [cw, ch] = g.res;
    const m3 = (e, v) => [e[0] * v[0] + e[3] * v[1] + e[6] * v[2], e[1] * v[0] + e[4] * v[1] + e[7] * v[2], e[2] * v[0] + e[5] * v[1] + e[8] * v[2]];
    const A = new Float32Array(W * H);
    for (let j = 0; j < H; j++)
      for (let i = 0; i < W; i++) {
        const fx = (i + 0.5) * (cw / W), fy = (j + 0.5) * (ch / H);
        let nx = (fx / cw) * 2 - 1, ny = (fy / ch) * 2 - 1;
        nx *= cw / ch;
        let d = m3(g.cam, [nx * g.tan, ny * g.tan, -1]);
        const l = Math.hypot(...d); d = d.map((x) => x / l);
        const w = m3(g.c2w, d);
        const c = w[0] * g.key[0] + w[1] * g.key[1] + w[2] * g.key[2];
        A[j * W + i] = (Math.acos(Math.min(1, Math.max(-1, c))) * 180) / Math.PI;
      }
    return A;
  };
  // 太阳在屏幕上的位置（全分辨率像素，原点左上，便于对照截图）
  const sunScreen = (g) => {
    const m3t = (e, v) => [e[0] * v[0] + e[1] * v[1] + e[2] * v[2], e[3] * v[0] + e[4] * v[1] + e[5] * v[2], e[6] * v[0] + e[7] * v[1] + e[8] * v[2]];
    const c = m3t(g.cam, m3t(g.c2w, g.key));
    if (c[2] >= 0) return null;
    const nx = c[0] / -c[2] / g.tan / (g.res[0] / g.res[1]), ny = c[1] / -c[2] / g.tan;
    return [((nx + 1) / 2) * g.res[0], (1 - (ny + 1) / 2) * g.res[1]];
  };
  const decode = (r) => new Float32Array(Buffer.from(r.b64, "base64").buffer.slice(0));
  const metrics = (buf, W, H, ang) => {
    const out = {};
    let cs = 0, cn = 0;
    const Y = new Float32Array(W * H), AL = new Float32Array(W * H);
    for (let k = 0; k < W * H; k++) {
      const a = 1 - buf[4 * k + 3];
      AL[k] = a;
      Y[k] = 0.2126 * buf[4 * k] + 0.7152 * buf[4 * k + 1] + 0.0722 * buf[4 * k + 2];
      if (a > 0.5) { cs += Y[k] / a; cn++; }
    }
    out.cloud = cn ? +(cs / cn).toFixed(3) : 0;
    out.cloudPx = cn;
    if (ang) {
      const band = (lo, hi) => {
        let rs = 0, rn = 0, ks = 0, kn = 0;
        const rv = [];
        for (let k = 0; k < W * H; k++) {
          if (ang[k] < lo || ang[k] > hi) continue;
          const a = AL[k];
          if (a >= 0.2 && a <= 0.7) { rs += Y[k] / a; rn++; rv.push(Y[k] / a); }
          else if (a >= 0.97) { ks += Y[k] / a; kn++; }
        }
        rv.sort((x, y) => x - y);
        const core = kn ? ks / kn : NaN;
        return { rim: rn ? +(rs / rn / core).toFixed(3) : null, rimP90: rn ? +(rv[Math.floor(rn * 0.9)] / core).toFixed(3) : null, rimPx: rn, corePx: kn, core: +core.toFixed(3), edge: rn ? +(rs / rn).toFixed(3) : null };
      };
      out.r15 = band(0, 15);
      out.r38 = band(3, 8);
    }
    return { out, Y, AL };
  };

  const setupScene = async (sc) => {
    const info = await page.evaluate(applyScene, { sc, defaults: DEFAULTS, settle: !!sc.ground });
    await page.evaluate(() => window.__voyage.quality.setTier("high"));
    await page.evaluate((o) => { const v = window.__voyage; if (o) v.cloudUniforms.uCloudOffset.value.set(o[0], o[1]); v.snapAll(); }, sc.offset || null);
    await page.evaluate(() => window.__cs.frames(4));
    await page.evaluate((o) => { const v = window.__voyage; if (o) v.cloudUniforms.uCloudOffset.value.set(o[0], o[1]); v.freeze(true); }, sc.offset || null);
    await page.evaluate(() => window.__cs.frames(3));
    return info;
  };

  if (args.find) {
    const sc = findScene(args.scene || "backlit-close");
    const info = await setupScene(sc);
    const g = await page.evaluate(() => window.__cs.geom());
    log("场景", sc.name, info.replace(/\n/g, " | "));
    log("航向", g.heading.toFixed(2), "太阳高度", g.sunAlt.toFixed(2), "太阳在屏幕", JSON.stringify(sunScreen(g)?.map((x) => Math.round(x))));
    const [g0, g1, gs] = (args.grid ? String(args.grid) : "-12,12,1.5").split(",").map(Number);
    const res = [];
    let ang = null;
    for (let ox = g0; ox <= g1 + 1e-6; ox += gs)
      for (let oy = g0; oy <= g1 + 1e-6; oy += gs) {
        // 深度半边只在附近有高地形时写（PERF-11）：临时把 uTerrainMax 抬高，让它写出云的平均距离
        await page.evaluate(([x, y]) => { const v = window.__voyage; v.clouds.view.uTerrainMax.value = 50; v.cloudUniforms.uCloudOffset.value.set(x, y); window.__cs.accumulate(6); }, [ox, oy]);
        const rf = await page.evaluate(() => window.__cs.readCloud(true));
        const full = decode(rf);
        const r = { W: rf.W / 2, H: rf.H };
        const buf = new Float32Array(r.W * r.H * 4);
        for (let j = 0; j < r.H; j++) buf.set(full.subarray(j * rf.W * 4, (j * rf.W + r.W) * 4), j * r.W * 4);
        if (!ang) ang = angleMap(g, r.W, r.H);
        // 太阳 3° 以内云的平均距离（km）
        let dz = 0, dn = 0;
        for (let j = 0; j < r.H; j++) for (let i = 0; i < r.W; i++) {
          const k = j * r.W + i;
          if (ang[k] > 3) continue;
          const q = (j * rf.W + r.W + i) * 4;
          if (full[q + 1] > 0.5) { dz += full[q] / full[q + 1]; dn++; }
        }
        // 太阳处的不透明度、3–8° 环带里边 / 芯的像素数
        // 另数 3–12° 里的天空像素（α < 0.05）与整窗云量：要「一团云挡住太阳、旁边是天」，不要贴脸的云
        let sunA = 0, sn = 0, edge = 0, core = 0, sky = 0, win = 0, cov = 0;
        for (let k = 0; k < r.W * r.H; k++) {
          const a = 1 - buf[4 * k + 3];
          if (ang[k] < 1.0) { sunA += a; sn++; }
          if (ang[k] >= 3 && ang[k] <= 8) { if (a >= 0.2 && a <= 0.7) edge++; else if (a >= 0.97) core++; }
          if (ang[k] >= 3 && ang[k] <= 12 && a < 0.05) sky++;
          if (buf[4 * k + 3] < 1 || buf[4 * k] > 0) { win++; if (a > 0.5) cov++; }
        }
        res.push({ ox, oy, sunA: +(sunA / Math.max(sn, 1)).toFixed(3), edge, core, sky, cov: +(cov / Math.max(win, 1)).toFixed(3), km: dn ? +(dz / dn).toFixed(1) : null });
      }
    const score = (r) => (r.sunA > 0.95 && r.cov < 0.7 ? Math.min(r.edge, r.sky, r.core) : -1);
    res.sort((a, b) => score(b) - score(a));
    for (const r of res.slice(0, 12)) log(JSON.stringify(r));
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(path.join(OUT, "find.json"), JSON.stringify(res, null, 1));
  } else {
    const { VARIANTS } = await import(pathToFileURL(path.resolve(args.vfile)).href);
    const wanted = args.variants ? String(args.variants).split(",") : Object.keys(VARIANTS);
    const sceneList = String(args.scenes || "backlit-close").split(",").map(findScene);
    const crop = (args.crop ? String(args.crop) : "420,300,760,700").split(",").map(Number);
    for (const sc of sceneList) {
      const dir = path.join(OUT, sc.name);
      fs.mkdirSync(dir, { recursive: true });
      const info = await setupScene(sc);
      const g = await page.evaluate(() => window.__cs.geom());
      const sun = sunScreen(g);
      const meta = { scene: sc.name, info: info.replace(/\n/g, " | "), key: await page.evaluate(() => window.__cs.shownKey()), heading: g.heading, sunAlt: g.sunAlt, sun, variants: {} };
      let base = null, ang = null;
      for (const vn of wanted) {
        const V = VARIANTS[vn];
        if (!V) { log("没有变体", vn); continue; }
        const changed = await page.evaluate((p) => window.__cs.patch(p), V.march || []);
        if (changed) await page.evaluate(() => window.__cs.compile());
        const rt = await page.evaluate(([c]) => window.__cs.realtime(96, 128, c), [crop]);
        await page.screenshot({ path: path.join(dir, vn + ".png") });
        const r = await page.evaluate(() => window.__cs.readCloud());
        const buf = decode(r);
        if (!ang && sun) ang = angleMap(g, r.W, r.H);
        const { out, Y, AL } = metrics(buf, r.W, r.H, ang);
        if (!base) base = { Y, AL };
        else {
          let s = 0, sy = 0;
          for (let k = 0; k < Y.length; k++) if (AL[k] > 0.05 || base.AL[k] > 0.05) { s += Math.abs(Y[k] - base.Y[k]); sy += base.Y[k]; }
          out.dRel = +(s / Math.max(sy, 1e-9)).toFixed(4);
        }
        if (args.bin) {
          fs.writeFileSync(path.join(dir, vn + ".bin"), Buffer.from(buf.buffer));
          if (ang) fs.writeFileSync(path.join(dir, "ang.bin"), Buffer.from(ang.buffer));
        }
        meta.variants[vn] = { rt, ...out };
        log(sc.name, vn, JSON.stringify(meta.variants[vn]));
      }
      await page.evaluate(() => window.__cs.patch([]));
      await page.evaluate(() => window.__voyage.freeze(false));
      fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify(meta, null, 2));
    }
  }
} finally {
  await closeBrowserSafely(browser);
}
