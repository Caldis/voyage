#!/usr/bin/env node
// DX-08：泛化自 handoff/T45-probe.mjs 的定位工具——应用一个场景 → 可选页面内替换着色器片段（--patch）
// → 等新程序真正编译完成（renderer.compileAsync，不是盲等几秒）→ 截图 → 读回指定渲染目标区域的数值
// （云缓冲 / 窗外 HDR / 曝光，或任意 __voyage 下可达的 WebGLRenderTarget）。
//
// 用法：
//   node scripts/probe.mjs --port 5244 --scene '<JSON>' [--patch 文件.mjs]
//     [--read '{"target":"cloud","x":800,"y":600}'] ... [--out tmp/screenshot/probe-5244] [--angle vulkan|d3d11] [--settle]
//
// --scene '<JSON>'：字段同 scripts/scenarios.mjs 的 SCENES 条目（和 dev-browser.mjs 的 --scene 一致）。
//
// --patch 文件：导出 `PATCHES = [{ mat, replace, target? }, ...]`：
//   mat      材质在 window.__voyage 下的点号路径，如 "clouds.marchMat"、"outsideMat"、"sceneMat"、
//            "wingMat"、"clouds.shadowMat"、"clouds.resolveMat"（云、场景、窗外这几个类是 TS `private`
//            字段，但那只是编译期检查，运行时就是普通属性，点号路径照样能取到）。
//   replace  [[查找文本, 替换文本], ...]：按 fragmentShader 原文（每次都从这个材质「从未改动过」的原始
//            文本开始）做精确字符串替换；某一对文本找不到会抛错退出（防止「删错了地方」，见 README 坑点
//            「用 Python 做删除第一处匹配」——新插入的代码可能恰好是第一处匹配，真正要删的反而留下）。
//   target   可选：这个材质实际渲染到的目标的点号路径（如 "hdrOutside"、"clouds.raw"），compileAsync 时
//            绑定同一张目标——D3D11 上按「链接时绑定的帧缓冲」生成像素着色器输出布局，绑错的话首次真正
//            使用时仍会同步重编（见 README 坑点）。不传就用 hdrOutside，多数全屏材质是单输出，通常无妨。
//
// --read（可重复）：'{"target":"cloud"|"outside"|"exposure"|"<点号路径>","x":,"y":,"w":1,"h":1}'
//   坐标是目标自身分辨率下的像素坐标（左上角原点），不是屏幕坐标——目标分辨率可能和视口不同（云按画质
//   档降分辨率、曝光是 2×1 的适应结果）；输出里带 width/height 方便换算。别名：
//     cloud    = clouds.history.0（云历史缓冲；T46 起浮点，之前半精度——两种都按纹理类型自动解码）
//     outside  = hdrOutside（窗外 HDR）
//     exposure = exposure.adapted.0（适应结果，2×1：左像素 = 窗外对数均值 / 舱内按面积 / 窗外线性均值
//                三个 log2 亮度 + 倒影增益，右像素 = 色度，见 render/exposure.ts 头部注释与 EXPOSURE_MODEL）
//
// 为什么要等 compileAsync 而不是盲等几秒：three.js 的 `needsUpdate = true` 不会立刻编译，等到下一次真正
// render() 才编译；D3D11 上大程序同步编译可能长达几十秒，直接同步渲染有卡死丢上下文的风险（README 坑点
// 「FXC 会把常量上界的循环整个展开」）。这里借用 `clouds.pass` 内部共享的全屏三角形 scene/camera（和
// main.ts 启动时后台编译同一套机制：`renderer.compileAsync(scene, camera)` 返回的 Promise 在真正编译完成
// 后才 resolve，不需要自己轮询），编译真正完成再截图、读数。
import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DEFAULTS, applyScene } from "./scenarios.mjs";
import { launchBrowser, closeBrowserSafely, resolveRepoPath } from "./lib/chrome.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VOYAGE_ROOT = path.join(HERE, "..");
const REPO_ROOT = path.join(VOYAGE_ROOT, "..", "..");

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      let val;
      if (next !== undefined && !next.startsWith("--")) {
        val = next;
        i++;
      } else val = true;
      if (key in out) out[key] = Array.isArray(out[key]) ? [...out[key], val] : [out[key], val];
      else out[key] = val;
    } else out._.push(a);
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.port || !args.scene) {
    console.error(
      "用法：node scripts/probe.mjs --port <端口> --scene '<JSON>' [--patch 文件.mjs] [--read '<JSON>' ...]\n" +
        "                            [--out 目录] [--angle d3d11|vulkan] [--settle] [--compile-timeout ms]",
    );
    process.exit(1);
  }
  const port = args.port;
  const angle = args.angle || "vulkan"; // 定位问题图快；验收口径要在 d3d11 上再看一眼时显式传 --angle d3d11
  const sc = JSON.parse(args.scene);
  const settle = Boolean(args.settle);
  const compileTimeout = Number(args["compile-timeout"] || 120000);
  const outDir = resolveRepoPath(REPO_ROOT, args.out || `tmp/screenshot/probe-${port}`);
  fs.mkdirSync(outDir, { recursive: true });

  const reads = (Array.isArray(args.read) ? args.read : args.read ? [args.read] : []).map((s, i) => {
    try {
      return JSON.parse(s);
    } catch (err) {
      throw new Error(`--read 第 ${i + 1} 个不是合法 JSON：${err.message}\n收到：${s}`);
    }
  });

  let PATCHES = [];
  if (args.patch) {
    const mod = await import(pathToFileURL(path.resolve(args.patch)).href);
    PATCHES = mod.PATCHES || [];
    if (PATCHES.length === 0) console.warn(`[probe] ${args.patch} 没有导出非空的 PATCHES 数组，跳过替换`);
  }

  const browser = await launchBrowser(chromium, { angle });
  try {
    const ctx = await browser.newContext({ viewport: { width: 1600, height: 1200 }, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    page.on("pageerror", (e) => console.log("[pageerror]", e.message));
    page.on("console", (m) => {
      if (m.type() === "error") console.log("[console.error]", m.text().slice(0, 400));
    });
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "commit", timeout: 180000 });
    await page.waitForFunction(() => window.__voyageStartup, null, { timeout: 300000, polling: 500 });

    // 页面内小工具：点号路径解析、打补丁（含原文缓存 + 还原）、按目标读区域（含半精度解码）
    await page.evaluate(() => {
      const v = window.__voyage;
      const resolvePath = (root, p) => p.split(".").reduce((o, k) => (o == null ? o : Array.isArray(o) ? o[Number(k)] : o[k]), root);
      const ALIAS = { cloud: "clouds.history.0", outside: "hdrOutside", exposure: "exposure.adapted.0" };
      // 半精度 → JS number（IEEE 754 binary16），与 handoff/T45-probe.mjs 的 h2f 一致
      const h2f = (h) => {
        const s = h & 0x8000 ? -1 : 1;
        const e = (h >> 10) & 31;
        const f = h & 1023;
        return e === 0 ? s * 2 ** -14 * (f / 1024) : e === 31 ? (f ? NaN : s * Infinity) : s * 2 ** (e - 15) * (1 + f / 1024);
      };
      const origShaders = new Map();
      window.__probe = {
        resolve: (p) => resolvePath(v, p),
        patch(entries) {
          const applied = [];
          for (const { mat, replace } of entries) {
            const m = resolvePath(v, mat);
            if (!m) throw new Error(`--patch：解析不到材质 "${mat}"`);
            if (!origShaders.has(m)) origShaders.set(m, m.fragmentShader);
            let s = origShaders.get(m);
            for (const [from, to] of replace) {
              if (!s.includes(from)) throw new Error(`--patch：材质 "${mat}" 里找不到查找文本：${from.slice(0, 100)}`);
              s = s.split(from).join(to);
            }
            m.fragmentShader = s;
            m.needsUpdate = true;
            applied.push(mat);
          }
          return applied;
        },
        restore() {
          for (const [m, s] of origShaders) {
            m.fragmentShader = s;
            m.needsUpdate = true;
          }
        },
        // 借 clouds.pass 内部共享的全屏三角形 scene/camera（FullscreenPass，见 render/pass.ts）：
        // 所有全屏材质本来就靠它渲染，用同一份几何体 + camera 发起 compileAsync 和真实使用完全一致。
        async compileWait(entries) {
          const renderer = v.clouds.pass.renderer;
          const passObj = v.clouds.pass;
          for (const { mat, target } of entries) {
            const m = resolvePath(v, mat);
            const tgt = target ? resolvePath(v, target) : v.hdrOutside;
            const prevMat = passObj.mesh.material;
            const prevTarget = renderer.getRenderTarget();
            passObj.mesh.material = m;
            renderer.setRenderTarget(tgt);
            await renderer.compileAsync(passObj.scene, passObj.camera);
            passObj.mesh.material = prevMat;
            renderer.setRenderTarget(prevTarget);
          }
        },
        readRegion(target, x, y, w, h) {
          const resolved = ALIAS[target] || target;
          const t = resolvePath(v, resolved);
          if (!t || !t.texture) throw new Error(`--read：解析不到渲染目标 "${target}"（-> ${resolved}）`);
          const renderer = v.clouds.pass.renderer;
          const isFloat = t.texture.type === 1015; // THREE.FloatType；其余（半精度）按 Uint16 读、手动解码
          const n = w * h * 4;
          const raw = isFloat ? new Float32Array(n) : new Uint16Array(n);
          renderer.readRenderTargetPixels(t, x, y, w, h, raw);
          const vals = isFloat ? Array.from(raw) : Array.from(raw, h2f);
          const rows = [];
          for (let j = 0; j < h; j++) rows.push(vals.slice(j * w * 4, (j + 1) * w * 4));
          return { target, resolved, width: t.width, height: t.height, x, y, w, h, rows };
        },
      };
    });

    const info = await page.evaluate(applyScene, { sc, defaults: DEFAULTS, settle });
    console.log(info.replace(/\n/g, " | "));

    if (PATCHES.length > 0) {
      const applied = await page.evaluate((entries) => window.__probe.patch(entries), PATCHES);
      console.log(`[probe] 已替换：${applied.join(", ")}`);
      console.log(`[probe] 等待 compileAsync（最长 ${compileTimeout} ms）...`);
      const t0 = Date.now();
      await Promise.race([
        page.evaluate((entries) => window.__probe.compileWait(entries), PATCHES),
        new Promise((_, reject) => setTimeout(() => reject(new Error(`compileAsync 超过 ${compileTimeout} ms 未完成`)), compileTimeout)),
      ]);
      console.log(`[probe] 编译完成，用时 ${Date.now() - t0} ms`);
      // 重新摆一次场景：天气 / 云偏移按飞机此刻位置重摆，画面是「新程序 + 当前场景」的组合，不是补丁前的残留状态
      await page.evaluate(applyScene, { sc, defaults: DEFAULTS, settle });
    }

    const pngPath = path.join(outDir, `${sc.name}.png`);
    await page.screenshot({ path: pngPath });
    console.log(`[probe] 截图 ${path.relative(REPO_ROOT, pngPath).replace(/\\/g, "/")}`);

    const results = [];
    for (const r of reads) {
      const { target, x, y, w = 1, h = 1 } = r;
      const val = await page.evaluate(({ target, x, y, w, h }) => window.__probe.readRegion(target, x, y, w, h), { target, x, y, w, h });
      results.push(val);
      console.log(`[probe] ${target} @ (${x},${y}) ${w}x${h}（目标 ${val.width}x${val.height}）: ${JSON.stringify(val.rows)}`);
    }
    if (results.length > 0) {
      const readsPath = path.join(outDir, `${sc.name}-reads.json`);
      fs.writeFileSync(readsPath, JSON.stringify(results, null, 2));
      console.log(`[probe] 读数写入 ${path.relative(REPO_ROOT, readsPath).replace(/\\/g, "/")}`);
    }
  } finally {
    await closeBrowserSafely(browser);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(`[probe] 失败：${err.message}`);
    process.exit(1);
  });
