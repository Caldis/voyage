// DX-23 / DX-24：`dev-browser.mjs ab` 与 `dev-browser.mjs flight` 的实现（从 dev-browser.mjs 拆出来，免得那个文件再长 1000 行）。
// 收编第 7 波各任务自写的同页 A/B / 时间行为脚本：handoff/C11-ab.mjs、C12-ab.mjs、C12b-ab.mjs、T48b-ab.mjs、
// T48c-motion.mjs、W-STAIR-diag.mjs、TM01-measure.mjs。用法与 jobs / variants 文件格式见 README「调试与验证」。
//
// 共用的「变体」格式（ab 与 flight 同一套，JSON 数组）：
//   { "name": "new",                                   // 必填，输出文件名的一部分
//     "materials": { "<材质路径>": "<来源>" , ... },    // 可选，整段换着色器原文；一次可换多个材质（主 + 湿窗变体……）
//     "patch": { "<材质路径>[,<材质路径>…]": [["查找", "替换"], ...] },  // 可选，在原文（或 materials 换上的原文）上做文本补丁
//     "defines": { "<材质路径>": { "KEY": "1" } },       // 可选，叠加 #define
//     "uniforms": { "<点号路径>": 值 },                  // 可选，如 "sceneMat.uniforms.uWingEdgeAA.value": 0；数组值走 fromArray
//     "js": "v.wingDebug.strobe = 0;" }                  // 可选，最后执行的一段 js（v = window.__voyage），可 await
//   <来源>：
//     "current"          页面当前代码的原文（= 不换，列出来只是为了和别的变体对称）
//     "base"             从 --base <对照端口> 的活页面读同一材质路径的原文（master 原文）
//     "base:<材质路径>"   从对照端口读另一个材质路径的原文（例：湿窗变体 wingMat.wet 在对照页面上可能还没编，用 "base:wingMat"，
//                        WING_WET 这个 define 由材质自己的 defines 带，不在原文里）
//     "file:<路径>"       读文件（相对仓库根或绝对路径），如 C12b 那样先把 master 原文存成文件
//   材质路径：和 shots --material 一样，另外认 cabinClass.current / cabinClass.seat / wingMat.current / wingMat.wet /
//   clouds.marchMat（当前实际画的步进变体）。
//   每个变体开始前先把**所有**变体碰过的材质原文 / defines / uniform 复原成页面初始值，变体之间互不串味。
//   换完着色器会 compileAsync + 真正 render 一次，并检查 diagnostics.runnable，编译失败直接报错（不拍垃圾画面）。
import fs from "node:fs";
import path from "node:path";
import { DEFAULTS, SCENES, applyScene, pinGeometry } from "../scenarios.mjs";
import { resolveRepoPath } from "./chrome.mjs";
import { acquireOrWait } from "./measure-lock.mjs";
import { groundSettle, groundUploads, readGround, setGround, dumpClouds, saveCloudDump, runLive, printLive } from "./ab-live.mjs";
import { cloudMetrics, printCloudMetrics } from "./cloud-metrics.mjs";

// ---------- 小工具 ----------
export const raf = (page, n = 2) => page.evaluate((n) => new Promise((r) => { let k = 0; const f = () => (++k >= n ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); }), n);

export function readJson(repoRoot, p, label) {
  if (!p) throw new Error(`缺少 ${label}`);
  const abs = resolveRepoPath(repoRoot, String(p));
  if (!fs.existsSync(abs)) throw new Error(`${label} 找不到文件：${p}`);
  try {
    return JSON.parse(fs.readFileSync(abs, "utf8"));
  } catch (err) {
    throw new Error(`${label} "${p}" 不是合法 JSON：${err.message}`);
  }
}

/** job.scene：场景名（scenarios.mjs 的 SCENES）或场景对象；job.offset 覆盖云偏移（多姿态） */
export function sceneOf(job) {
  let sc = typeof job.scene === "string" ? SCENES.find((s) => s.name === job.scene) : job.scene;
  if (!sc) throw new Error(`job "${job.name}"：没有场景 "${job.scene}"（已知：${SCENES.map((s) => s.name).join(", ")}）`);
  sc = { p: {}, ...sc };
  if (job.offset) sc = { ...sc, offset: job.offset };
  if (job.head) sc = { ...sc, head: job.head };
  return sc;
}

/** 等测量锁并持锁（ab / flight 都是逐像素 / 时间行为测量，别人的冷编译会让预热判据和帧间隔失真）。
 * DX-26：转给 lib/measure-lock.mjs 的 acquireOrWait——外层已持锁（同进程或带同一令牌的父进程）时不再自锁 */
export async function acquireMeasureLock(repoRoot, owner, log) {
  return acquireOrWait(repoRoot, owner, log);
}

// ---------- 页面内：变体库（page.evaluate 只序列化函数本身，全部内联） ----------
export function installVariantLib() {
  const v = window.__voyage;
  function resolveLiveMaterial(materialPath) {
    if (materialPath === "cabinClass.current" && v.cabinClass && v.cabinClass.mats) {
      const pair = v.cabinClass.mats[v.cabinClass.shown];
      return pair ? pair.cabin || pair : null;
    }
    if (materialPath === "cabinClass.seat" && v.cabinClass) {
      if (typeof v.cabinClass.seat === "function") return v.cabinClass.seat();
      const pair = v.cabinClass.mats && v.cabinClass.mats[v.cabinClass.shown];
      return pair ? pair.seat || null : null;
    }
    if (materialPath === "wingMat.current" && v.wingVariant) return v.wingVariant.shownWet ? v.wingVariant.wet : v.wingMat;
    if (materialPath === "wingMat.wet" && v.wingVariant) return v.wingVariant.wet || null;
    if (materialPath === "clouds.marchMat" && v.clouds && v.clouds.marchVariants && v.clouds.marchShown !== undefined) {
      const variant = v.clouds.marchVariants.get(v.clouds.marchShown || "");
      if (variant && variant.mat) return variant.mat;
    }
    return materialPath.split(".").reduce((o, k) => (o == null ? o : o[k]), v);
  }
  function targetFor(materialPath) {
    if (materialPath === "sceneMat" || materialPath === "cabinClass.current") return (v.cabinClass && v.cabinClass.target) || v.hdrOutside;
    if (materialPath === "seatMat" || materialPath === "cabinClass.seat") return v.hdrSeat || (v.cabinClass && v.cabinClass.seatTarget) || v.hdrOutside;
    if (materialPath.startsWith("wingMat")) return v.hdrWing || v.hdrOutside;
    if (materialPath === "clouds.resolveMat") return v.clouds.history[0];
    if (materialPath.startsWith("clouds.")) return v.clouds.raw;
    return v.hdrOutside;
  }
  const getPath = (p) => p.split(".").reduce((o, k) => (o == null ? o : o[k]), v);
  const setPath = (p, val) => {
    const keys = p.split(".");
    const last = keys.pop();
    const obj = keys.reduce((o, k) => (o == null ? o : o[k]), v);
    if (obj == null) throw new Error(`uniforms：解析不到 "${p}"`);
    const cur = obj[last];
    if (Array.isArray(val) && cur && typeof cur.fromArray === "function") cur.fromArray(val);
    else obj[last] = val;
  };
  const snapVal = (x) => (x && typeof x.clone === "function" ? x.clone() : x);
  const origSrc = new Map(); // mat -> { src, defines }
  const origUni = new Map(); // path -> value 快照
  const touched = new Map(); // materialPath -> mat（出现过的材质，复原用）
  window.__dx = {
    resolveLiveMaterial,
    /** 记录所有变体会碰到的材质与 uniform 的初始值（第一次调用 apply 前调用一次） */
    prepare(matPaths, uniPaths) {
      for (const p of matPaths) {
        const m = resolveLiveMaterial(p);
        if (!m || typeof m.fragmentShader !== "string") throw new Error(`材质路径 "${p}" 解析不到 ShaderMaterial（变体可能还没编好，例如窗从没湿过时 wingMat.wet 是 null）`);
        touched.set(p, m);
        if (!origSrc.has(m)) origSrc.set(m, { src: m.fragmentShader, defines: { ...(m.defines || {}) } });
      }
      for (const p of uniPaths) if (!origUni.has(p)) origUni.set(p, snapVal(getPath(p)));
      return [...touched.keys()];
    },
    /** DX-26：prepare 记下的材质对象本身（gpu-ab 核对「计时区间里真的画到了它」用） */
    mat(p) {
      return touched.get(p) || resolveLiveMaterial(p);
    },
    original(p) {
      const m = touched.get(p) || resolveLiveMaterial(p);
      return origSrc.has(m) ? origSrc.get(m).src : m && m.fragmentShader;
    },
    restore() {
      for (const [m, o] of origSrc) {
        if (m.fragmentShader !== o.src || JSON.stringify(m.defines || {}) !== JSON.stringify(o.defines)) {
          m.fragmentShader = o.src;
          m.defines = { ...o.defines };
          m.needsUpdate = true;
        }
      }
      for (const [p, val] of origUni) setPath(p, snapVal(val));
    },
    /** 套用一个变体：srcByPath = Node 侧解析好的 { 材质路径: 原文 }；patches = { 材质路径: [[a,b],...] } */
    async apply({ srcByPath, patches, defines, uniforms, js }) {
      this.restore();
      const changed = new Set();
      for (const [p, m] of touched) {
        let s = srcByPath[p] != null ? srcByPath[p] : origSrc.get(m).src;
        for (const pr of patches[p] || []) {
          // DX-26：补丁除 [查找, 替换]（字面、全部替换）外，还可以是 { re, flags?, to, optional? }（正则，默认 flags "g"，
          // to 里可用 $1）；optional: true 时找不到就跳过（内置诊断变体要同时适配几代云着色器，靠它）
          if (Array.isArray(pr)) {
            const [a, b, optional] = pr;
            if (!s.includes(a)) {
              if (optional) continue;
              throw new Error(`patch：材质 "${p}" 里找不到查找文本：${a.slice(0, 100)}`);
            }
            s = s.split(a).join(b);
          } else {
            const re = new RegExp(pr.re, pr.flags ?? "g");
            if (!re.test(s)) {
              if (pr.optional) continue;
              throw new Error(`patch：材质 "${p}" 里正则没有匹配：/${pr.re}/`);
            }
            re.lastIndex = 0;
            s = s.replace(re, pr.to);
          }
        }
        const defs = defines[p] ? { ...origSrc.get(m).defines, ...defines[p] } : null;
        if (s !== m.fragmentShader || defs) {
          m.fragmentShader = s;
          if (defs) m.defines = defs;
          m.needsUpdate = true;
          changed.add(p);
        }
      }
      for (const [p, val] of Object.entries(uniforms || {})) setPath(p, val);
      let jsOut = null;
      if (js) jsOut = await new (async () => {}).constructor("v", js)(v);
      // 编译 + 真正 render 一次强制 acquire 程序（compileAsync 只保证编完），并查链接结果
      const passObj = v.clouds.pass;
      const renderer = passObj.renderer;
      for (const p of touched.keys()) {
        const m = touched.get(p);
        const prevMat = passObj.mesh.material;
        const prevT = renderer.getRenderTarget();
        const tgt = targetFor(p);
        passObj.mesh.material = m;
        renderer.setRenderTarget(tgt);
        await renderer.compileAsync(passObj.scene, passObj.camera);
        passObj.render(m, tgt);
        passObj.mesh.material = prevMat;
        renderer.setRenderTarget(prevT);
        const dg = renderer.properties.get(m)?.currentProgram?.diagnostics;
        if (dg && dg.runnable === false) throw new Error(`材质 "${p}" 编译 / 链接失败：\n${dg.fragmentShader.log || dg.programLog}`);
      }
      // 云的 resolve / 步进被上面那次 render 写进了历史：若碰了云材质，snap 一下让时间累积从干净的状态开始
      if ([...touched.keys()].some((p) => p.startsWith("clouds."))) v.clouds.snap();
      if (v.sceneMat && v.sceneMat.uniforms.uClouds) v.sceneMat.uniforms.uClouds.value = v.clouds.texture;
      // DX-26：每个被碰过的材质此刻绑定的 WebGLProgram 编号（three.js 的 program.id，全局自增）与原文长度——
      // gpu-ab 拿它确认「变体之间真的换了程序」（C10 因为换错材质误报过「GPU 持平」）
      const programs = {};
      const hashOf = (s) => {
        let h = 5381;
        for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
        return (h >>> 0).toString(16);
      };
      for (const [p, m] of touched) programs[p] = { id: renderer.properties.get(m)?.currentProgram?.id ?? null, hash: hashOf(m.fragmentShader + "\n" + JSON.stringify(m.defines || {})) };
      return { changed: [...changed], jsOut: jsOut === undefined ? null : jsOut, programs };
    },
  };
}

// ---------- DX-26：内置诊断变体（收编 handoff/C10b-var*.mjs 的 ref / dist / st_*） ----------
// 变体写 "builtin": "cloud-ref"（或数组，可与自己的 patch 叠加：先套自己的 patch，再套内置的），作用在当前实际画的云步进
// （clouds.marchMat）。补丁用正则 + optional，同时适配 master（C10：进云二分、上限 192）与 C10b 交付版（无二分、上限 384）。
//   cloud-ref   细步真值：步长 ×1/4（lod 仍按原步长 → 同一个密度场）、步数上限 3000、关进云二分（有的话）。
//               很贵（云步进约 ×4），只用来当 α / 边宽的参照，别拿它的截图看观感
//   cloud-dist  深度出口：输出 L = depth·α（α = 1 − T），配 job.cloudDump 读回后 Y/α = 这条视线上云的加权深度（km）
//   cloud-steps 步数用量：输出 R = 这条视线用掉的步数（α 通道 = 0）；cloudDump 读 raw（单帧、不经 resolve），出热图与分位数
export const BUILTIN_VARIANTS = {
  "cloud-ref": [
    ["(bis > 0 || (dens > 0.002 && wasEmpty && t < 60.0))", "(bis > 0)", true],
    // 循环头可带「+ uLoopGuard」（C10c 起云主循环是「448 + uLoopGuard」）
    { re: "for \\(int i = 0; i < (\\d{3,})( \\+ uLoopGuard)?; i\\+\\+\\) \\{", to: "for (int i = 0; i < 3000$2; i++) {" },
    { re: "i >= \\d{3,}(\\)+) break;", to: "i >= 3000$1 break;" },
    { re: "float dtBase = (clamp\\(t \\* [\\d.]+, [\\d.]+, [\\d.]+\\));", to: "float dtBase0 = $1; float dtBase = 0.25 * dtBase0;" },
    { re: "log2\\(dtBase / ", to: "log2(dtBase0 / " },
  ],
  "cloud-dist": [["  L = L * apT + apL * (1.0 - T);", "  L = vec3(depth) * (1.0 - T);"]],
  "cloud-steps": [
    { re: "\\n  for \\(int i = 0; i < (\\d{3,})( \\+ uLoopGuard)?; i\\+\\+\\) \\{\\n", to: "\n  float iUsed = 0.0;\n  for (int i = 0; i < $1$2; i++) {\n    iUsed = float(i);\n" },
    ["gl_FragColor = vec4(min(L, vec3(60000.0)), T);", "gl_FragColor = vec4(vec3(iUsed), 0.0);"],
    { re: "if \\(wSum <= 0\\.0\\) return;", to: "if (wSum <= 0.0) { depthSum = 1.0; wSum = 1.0; }" },
  ],
};
const builtinsOf = (va) => (va.builtin ? (Array.isArray(va.builtin) ? va.builtin : [va.builtin]) : []);

/** Node 侧：把变体里的「来源」解析成原文（base / base:<路径> / file: / current） */
export async function resolveSources(variants, { baseSource, repoRoot }) {
  const cache = new Map();
  const out = [];
  for (const va of variants) {
    const srcByPath = {};
    for (const [p, spec] of Object.entries(va.materials || {})) {
      const s = String(spec);
      if (s === "current") continue;
      if (s === "base" || s.startsWith("base:")) {
        const from = s === "base" ? p : s.slice(5);
        if (!cache.has(from)) cache.set(from, await baseSource(from));
        srcByPath[p] = cache.get(from);
      } else if (s.startsWith("file:")) {
        const f = resolveRepoPath(repoRoot, s.slice(5));
        if (!fs.existsSync(f)) throw new Error(`变体 "${va.name}"：找不到着色器文件 ${s.slice(5)}`);
        srcByPath[p] = fs.readFileSync(f, "utf8");
      } else throw new Error(`变体 "${va.name}"：材质 "${p}" 的来源 "${s}" 不认识（current | base | base:<材质路径> | file:<路径>）`);
    }
    // patch 的键可以是逗号分隔的多个材质路径（主 + 湿窗变体共用一组补丁）
    const patches = {};
    for (const [k, pairs] of Object.entries(va.patch || {})) for (const p of k.split(",")) patches[p.trim()] = pairs;
    for (const b of builtinsOf(va)) {
      if (!BUILTIN_VARIANTS[b]) throw new Error(`变体 "${va.name}"：内置变体 "${b}" 不认识（可选 ${Object.keys(BUILTIN_VARIANTS).join(" | ")}）`);
      patches["clouds.marchMat"] = [...(patches["clouds.marchMat"] || []), ...BUILTIN_VARIANTS[b]];
    }
    out.push({ name: va.name, srcByPath, patches, defines: va.defines || {}, uniforms: va.uniforms || {}, js: va.js || null, builtin: builtinsOf(va), ground: va.ground || null });
  }
  return out;
}

export function collectPaths(variants) {
  const mats = new Set();
  const unis = new Set();
  for (const va of variants) {
    for (const p of Object.keys(va.materials || {})) mats.add(p);
    for (const k of Object.keys(va.patch || {})) for (const p of k.split(",")) mats.add(p.trim());
    for (const p of Object.keys(va.defines || {})) mats.add(p);
    for (const p of Object.keys(va.uniforms || {})) unis.add(p);
    if (builtinsOf(va).length) mats.add("clouds.marchMat");
  }
  return { mats: [...mats], unis: [...unis] };
}

export function validateVariants(variants, label) {
  if (!Array.isArray(variants) || variants.length === 0) throw new Error(`${label} 应该是非空数组`);
  const names = new Set();
  for (const va of variants) {
    if (!va || !va.name) throw new Error(`${label}：每个变体都要有 name`);
    if (names.has(va.name)) throw new Error(`${label}：变体名重复 "${va.name}"`);
    names.add(va.name);
  }
}

// ---------- 页面内：图像指标（Canvas2D 解码 PNG；不需要真 GPU） ----------
async function analyzeShots(page, shots, refLabel, crop) {
  // shots: [{ label, file }]；只把 dataUrl 分批送进页面，避免一次塞太多（flicker 48 帧崩溃同一原因）
  await page.evaluate(() => { window.__dxImgs = {}; });
  for (const s of shots) {
    const dataUrl = `data:image/png;base64,${fs.readFileSync(s.file).toString("base64")}`;
    await page.evaluate(async ({ label, dataUrl }) => {
      const img = new Image();
      await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error("图片解码失败")); img.src = dataUrl; });
      const c = document.createElement("canvas");
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      const ctx = c.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(img, 0, 0);
      window.__dxImgs[label] = ctx.getImageData(0, 0, c.width, c.height);
    }, { label: s.label, dataUrl });
  }
  return page.evaluate(({ labels, refLabel, crop }) => {
    const imgs = window.__dxImgs;
    const ref = imgs[refLabel];
    const W = ref.width, H = ref.height;
    const [cx, cy, cw, ch] = crop || [0, 0, W, H];
    const lumAt = (d, i) => 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
    function diff(a, b) {
      let sum = 0, max = 0, over = 0, n = 0;
      for (let i = 0; i < a.data.length; i += 4) {
        const d = (Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1]) + Math.abs(a.data[i + 2] - b.data[i + 2])) / 3;
        sum += d;
        if (d > max) max = d;
        if (d > 8) over++;
        n++;
      }
      return { mean: +(sum / n).toFixed(3), max: +max.toFixed(1), over8: over };
    }
    function measure(im) {
      const d = im.data;
      let s = 0, n = 0, sH = 0, sD = 0, nD = 0, sat = 0, spread = 0;
      for (let y = cy; y < cy + ch; y++) for (let x = cx; x < cx + cw; x++) {
        const i = (y * W + x) * 4;
        const l = lumAt(d, i);
        s += l;
        n++;
        const mx = Math.max(d[i], d[i + 1], d[i + 2]), mn = Math.min(d[i], d[i + 1], d[i + 2]);
        spread += mx - mn;
        sat += mx > 0 ? (mx - mn) / mx : 0;
        if (x + 1 < cx + cw && y + 1 < cy + ch) {
          sH += Math.abs(l - lumAt(d, i + 4)) + Math.abs(l - lumAt(d, i + 4 * W));
          sD += Math.abs(l - lumAt(d, i + 4 * W + 4));
          nD++;
        }
      }
      return { luma: +(s / n).toFixed(2), adjDiff: +(sH / (2 * nD)).toFixed(3), adjDiffDiag: +(sD / nD).toFixed(3), hsvSat: +((100 * sat) / n).toFixed(2), rgbSpread: +(spread / n).toFixed(2) };
    }
    const rows = {};
    for (const l of labels) rows[l] = { ...measure(imgs[l]), vsRef: l === refLabel ? null : diff(imgs[l], ref) };
    window.__dxImgs = {};
    return rows;
  }, { labels: shots.map((s) => s.label), refLabel, crop: crop || null });
}

// ---------- ab ----------
export async function cmdAb(args, h) {
  const { REPO_ROOT, openPage, launchBrowser, setFlashDisabled, setWingStrobe, resolveBaseShaderSource, parseViewport, parseDpr, parseExtraQuery, setQualityTier, log } = h;
  const port = args.port;
  if (!port) throw new Error("ab 需要 --port <端口>");
  const angle = String(args.angle || "d3d11");
  const viewport = parseViewport(args);
  const dpr = parseDpr(args);
  const jobs = readJson(REPO_ROOT, args.jobs, "--jobs");
  if (!Array.isArray(jobs) || jobs.length === 0) throw new Error("--jobs 应该是非空数组");
  const variantsRaw = args.variants ? readJson(REPO_ROOT, args.variants, "--variants") : null;
  const rounds = Number(args.rounds || 2);
  const cloudLive = Boolean(args["cloud-live"]);
  const warmMax = Number(args["warm-max"] || 8);
  const outDir = resolveRepoPath(REPO_ROOT, args.out || `tmp/screenshot/ab-${port}`);
  fs.mkdirSync(outDir, { recursive: true });
  for (const j of jobs) {
    if (!j.name) throw new Error("--jobs：每个 job 都要有 name");
    sceneOf(j);
    if (j.variants) validateVariants(j.variants, `job "${j.name}" 的 variants`);
  }
  if (variantsRaw) validateVariants(variantsRaw, "--variants");
  if (!variantsRaw && jobs.some((j) => !j.variants)) throw new Error("没给 --variants 时，每个 job 都要自带 variants");

  const release = await acquireMeasureLock(REPO_ROOT, `dev-browser.mjs ab（端口 ${port}, pid ${process.pid}）`, log);
  const browser = await launchBrowser(angle);
  const summary = [];
  try {
    // --base <端口>：对照服务器；来源写 "base" 的材质从这里读原文（每个材质路径只读一次）
    const baseSource = async (matPath) => {
      if (!args.base) throw new Error(`变体里有来源 "base"，需要 --base <对照端口>`);
      return resolveBaseShaderSource(String(args.base), matPath, { browser, angle });
    };
    const { page, renderer, errors, tileErrors } = await openPage(browser, port, angle, viewport, dpr, { collectErrors: true, extraQuery: parseExtraQuery(args) });
    log(`ab --angle=${angle}  viewport=${viewport.width}x${viewport.height}  GL_RENDERER = ${renderer}`);
    await setQualityTier(page, args.quality);
    await setFlashDisabled(page, true);
    await page.evaluate(installVariantLib);
    const anaPage = await (await browser.newContext()).newPage();

    for (const job of jobs) {
      const variants = job.variants || variantsRaw;
      const sc = sceneOf(job);
      const resolved = await resolveSources(variants, { baseSource, repoRoot: REPO_ROOT });
      const t0 = Date.now();
      await page.evaluate(applyScene, { sc, defaults: DEFAULTS, settle: true });
      await page.evaluate(pinGeometry, sc);
      if (job.pre) await page.evaluate((code) => new (async () => {}).constructor("v", code)(window.__voyage), job.pre);
      // 变体要改的材质可能是后台编译的变体（湿窗 WING_WET 等）：先跑 90 帧让它们编好再冻结（W-STAIR 手法）
      await page.evaluate(async () => {
        for (let i = 0; i < 90; i++) await new Promise((r) => requestAnimationFrame(r));
        const wv = window.__voyage.wingVariant;
        for (let i = 0; i < 600 && wv && wv.state === "compiling"; i++) await new Promise((r) => requestAnimationFrame(r));
      });
      await page.evaluate((cl) => window.__voyage.freeze(true, { cloudLive: cl }), cloudLive);
      await setWingStrobe(page, 0);
      // DX-26：job.ground 简写（{ 开关: 值 }，如 G08c 的 demNightEdgeShared）：设好、rebuildAll，下面统一等瓦片
      if (job.ground) await setGround(page, job.ground, log, "job");
      // 冻结状态下等地面完全稳定（applyScene 的 settle 有超时；钉回机位后还可能触发新瓦片）。
      // G-FREEZE：pending === 0（+ 2 s）不够——瓦片取齐后拼接 / 合成 / 上传还要几秒，各级在截图之间陆续换上（night-city-low 同设置两张差 20 万像素）。
      // 改等 ground.unsettled() 连续 10 帧为 null 且换版计数不变（groundSettle）；之后每张图记换版计数，和这里的基线不同就作废
      const settle = await groundSettle(page, 120000);
      let groundBase = settle.uploads;
      log(`${job.name}：场景就绪 ${((Date.now() - t0) / 1000).toFixed(1)} s${settle.ok ? "" : `（等地面稳定超时：${settle.reason}）`}`);
      const { mats, unis } = collectPaths(variants);
      await page.evaluate(({ mats, unis }) => window.__dx.prepare(mats, unis), { mats, unis });
      // 变体级 ground：所有变体碰过的开关先记下 job 设好后的值，没写这个开关的变体按这个值（变了才 rebuildAll）
      const groundKeys = [...new Set(resolved.flatMap((va) => Object.keys(va.ground || {})))];
      const groundOrig = groundKeys.length ? await readGround(page, groundKeys) : null;
      const cloudDumpOpt = job.cloudDump ? { warm: 96, frames: 16, ...(job.cloudDump === true ? {} : job.cloudDump) } : null;

      const jdir = path.join(outDir, job.name);
      fs.mkdirSync(jdir, { recursive: true });
      const shots = [];
      // 交替排序：old,new,old#2,new#2……同一变体两轮之差就是噪声底（换材质这个动作本身有没有副作用也在里面）
      for (let r = 0; r < rounds; r++) {
        for (const va of resolved) {
          const label = r === 0 ? va.name : `${va.name}#${r + 1}`;
          const e0 = errors.length;
          const te0 = tileErrors.n;
          // 变体级 ground 有意 rebuildAll 了：换版计数的基线跟着换（setGround 已等到稳定）
          if (groundOrig && (await setGround(page, { ...groundOrig, ...(va.ground || {}) }, log, label)).changed) groundBase = await groundUploads(page);
          const res = await page.evaluate((va) => window.__dx.apply(va), va);
          // DX-26：cloudDump——换完变体先手动推进云并读回（全冻结时 rAF 不画云，这一步也让截图里的云是本变体收敛后的样子）
          let cloud = null;
          if (cloudDumpOpt) {
            const d = await dumpClouds(page, { steps: va.builtin.includes("cloud-steps"), ...cloudDumpOpt });
            const saved = await saveCloudDump(jdir, label.replace("#", "_r"), d, anaPage, cloudDumpOpt.heatTop || null);
            cloud = { kind: d.kind, W: d.W, H: d.H, marchKey: d.marchKey, steps: saved.steps || null };
            if (saved.steps) log(`  ${job.name}/${label} 步数用量：均值 ${saved.steps.mean}、p50/p90/p99 ${saved.steps.p50}/${saved.steps.p90}/${saved.steps.p99}、最大 ${saved.steps.max}${saved.steps.cap ? `、用满上限 ${saved.steps.cap} 的 ${saved.steps.atCapPct}%` : ""}（热图 ${label.replace("#", "_r")}.steps.png）`);
          }
          // 预热：冻结时连续两张截图逐字节相同才算稳定（换程序后前几帧可能还在切换 / 曝光合成读的是上一帧）；
          // cloud-live 时云一直在变，改成等 30 帧（DEV_SOP：cloudLive 改参要等约 30 帧）
          let buf = null;
          let warm = 0;
          if (cloudLive) {
            await raf(page, 30);
            buf = await page.screenshot({ timeout: 60000 });
          } else {
            await raf(page, 4);
            let prev = await page.screenshot({ timeout: 60000 });
            for (warm = 1; warm <= warmMax; warm++) {
              await raf(page, 2);
              buf = await page.screenshot({ timeout: 60000 });
              if (buf.equals(prev)) break;
              prev = buf;
            }
          }
          const stable = cloudLive ? null : warm <= warmMax;
          const file = path.join(jdir, `${label.replace("#", "_r")}.png`);
          fs.writeFileSync(file, buf);
          for (let z = 0; z < (job.zoom || []).length; z++) {
            const c = job.zoom[z];
            await page.screenshot({ path: file.replace(/\.png$/, `.z${z}.png`), clip: { x: c[0], y: c[1], width: c[2], height: c[3] } });
          }
          const meta = await page.evaluate(() => ({
            groundPending: window.__voyage.ground ? window.__voyage.ground.pending : null,
            groundUploads: window.__voyage.ground && typeof window.__voyage.ground.uploads === "number" ? window.__voyage.ground.uploads : null,
            quality: window.__voyage.quality ? { tier: window.__voyage.quality.tier, level: window.__voyage.quality.level } : null,
          }));
          let hdr = null;
          if (job.hdr) {
            hdr = await page.evaluate(({ tgtPath, label }) => {
              const v = window.__voyage;
              const t = tgtPath.split(".").reduce((o, k) => (o == null ? o : o[k]), v);
              if (!t || !t.isWebGLRenderTarget) throw new Error(`job.hdr "${tgtPath}" 不是渲染目标`);
              const buf = new Float32Array(t.width * t.height * 4);
              v.clouds.pass.renderer.readRenderTargetPixels(t, 0, 0, t.width, t.height, buf);
              (window.__dxHdr ??= {})[label] = buf;
              return { w: t.width, h: t.height };
            }, { tgtPath: job.hdr, label });
          }
          let bench = null;
          if (job.bench) {
            const ms = await page.evaluate((fn) => { const r = []; for (let i = 0; i < 7; i++) r.push(window.__voyage[fn](30)); return r.sort((a, b) => a - b); }, job.bench);
            bench = { fn: job.bench, median: +ms[3].toFixed(4), min: +ms[0].toFixed(4) };
          }
          const errs = errors.slice(e0);
          const cors = tileErrors.n - te0;
          // G-FREEZE：冻结期间地面换过版（换版计数 ≠ 稳定时的基线）→ 这张和别的不在同一份地面上
          const groundChanged = groundBase !== null && meta.groundUploads !== null && meta.groundUploads !== groundBase;
          const rec = { label, variant: va.name, round: r + 1, file: path.relative(REPO_ROOT, file).replace(/\\/g, "/"), warmShots: warm, stable, ...meta, groundChanged, errors: errs.length, corsErrors: cors, void: cors > 0 || (meta.groundPending ?? 0) > 0 || groundChanged, changed: res.changed, jsOut: res.jsOut, hdr, bench };
          if (rec.void) log(`  [作废] ${job.name}/${label}：这一张期间瓦片跨域失败 ${cors} 条 / pending=${meta.groundPending}${groundChanged ? ` / 冻结期间地面换版 ${meta.groundUploads - groundBase} 次` : ""}，地面可能缺瓦片或已换版，不要拿它下结论`);
          if (stable === false) log(`  [警告] ${job.name}/${label}：预热 ${warmMax} 轮仍未逐字节稳定（冻结没钉住某个状态？），差异里会混进这部分噪声`);
          if (meta.quality && meta.quality.level !== "high" && !args.quality) log(`  [警告] ${job.name}/${label}：画质档是 ${meta.quality.level}（自动降档？），与别的截图不可比`);
          rec.cloud = cloud;
          rec.programs = res.programs;
          shots.push(rec);
          fs.writeFileSync(file.replace(/\.png$/, ".json"), JSON.stringify(rec, null, 2));
        }
      }
      // DX-26：live 段（解冻、页内逐帧录全部帧 + 逐帧 uniform + 时间二阶差分区统计）
      let live = null;
      if (job.live) live = await runLive(page, job, resolved, { setWingStrobe, log, jdir, dpr });
      await page.evaluate(() => { window.__dx.restore(); window.__voyage.freeze(false); });
      await setWingStrobe(page, null);
      if (groundOrig) await setGround(page, groundOrig, log, "复原");
      // DX-26：云读回指标（有 cloud-ref 变体时对它算；有 cloud-dist 变体时按距离分带）
      let cloudRes = null;
      if (cloudDumpOpt) {
        const refVa = resolved.find((va) => va.builtin.includes("cloud-ref"));
        const distVa = resolved.find((va) => va.builtin.includes("cloud-dist"));
        const plain = resolved.filter((va) => va.builtin.length === 0).map((va) => va.name);
        if (refVa && plain.length) {
          const names = [...plain, ...(rounds > 1 ? plain.map((n) => `${n}_r2`) : [])];
          cloudRes = cloudMetrics(jdir, { ref: refVa.name, dist: distVa ? distVa.name : null, variants: names });
          printCloudMetrics(cloudRes, job.name);
        }
      }
      if (live) printLive(job.name, live, job.live);

      // 指标表：对第一个变体第 1 轮（ref）的差异 + 裁剪区测量；同一变体两轮之差 = 噪声底
      const refLabel = shots[0].label;
      const metrics = await analyzeShots(anaPage, shots.map((s) => ({ label: s.label, file: resolveRepoPath(REPO_ROOT, s.file) })), refLabel, job.crop);
      let hdrCmp = null;
      if (job.hdr) {
        hdrCmp = await page.evaluate(({ labels, ref, mask }) => {
          const B = window.__dxHdr[ref], M = mask ? window.__dxHdr[mask] : null;
          const out = {};
          for (const l of labels) {
            if (l === ref) continue;
            const A = window.__dxHdr[l];
            let diffPx = 0, max = 0, nonMask = 0, nonMaskDiffPx = 0, nonMaskMax = 0;
            for (let p = 0; p < A.length; p += 4) {
              let d = 0, same = !!M;
              for (let c = 0; c < 4; c++) {
                d = Math.max(d, Math.abs(A[p + c] - B[p + c]));
                if (M && M[p + c] !== B[p + c]) same = false;
              }
              if (d > 0) { diffPx++; if (d > max) max = d; }
              if (same) { nonMask++; if (d > 0) { nonMaskDiffPx++; if (d > nonMaskMax) nonMaskMax = d; } }
            }
            out[l] = { diffPx, maxAbs: max, ...(M ? { nonMaskPx: nonMask, nonMaskDiffPx, nonMaskMax } : {}) };
          }
          window.__dxHdr = {};
          return out;
        }, { labels: shots.map((s) => s.label), ref: refLabel, mask: job.hdrMask || null });
      }
      const noise = {};
      for (const va of resolved) {
        const a = shots.find((s) => s.label === va.name);
        const b = shots.find((s) => s.label === `${va.name}#2`);
        if (a && b) {
          const m = await analyzeShots(anaPage, [{ label: a.label, file: resolveRepoPath(REPO_ROOT, a.file) }, { label: b.label, file: resolveRepoPath(REPO_ROOT, b.file) }], a.label, job.crop);
          noise[va.name] = m[b.label].vsRef;
        }
      }
      console.log(`\n== ${job.name}（参照 ${refLabel}，裁剪 ${job.crop ? job.crop.join(",") : "整图"}；差异 0–255，over8 = 差 > 8 的像素数）`);
      console.log("| 截图 | 亮度 | 相邻差 | 对角差 | HSV 饱和% | RGB max−min | vs 参照 mean / max / over8 | 噪声底（同变体两轮）mean / max | 作废 |");
      console.log("|---|---:|---:|---:|---:|---:|---|---|---|");
      for (const s of shots) {
        const m = metrics[s.label];
        const vr = m.vsRef ? `${m.vsRef.mean} / ${m.vsRef.max} / ${m.vsRef.over8}` : "—";
        const nz = s.round === 1 && noise[s.variant] ? `${noise[s.variant].mean} / ${noise[s.variant].max}` : "";
        console.log(`| ${s.label} | ${m.luma} | ${m.adjDiff} | ${m.adjDiffDiag} | ${m.hsvSat} | ${m.rgbSpread} | ${vr} | ${nz} | ${s.void ? "作废" : ""} |`);
      }
      if (hdrCmp) {
        console.log(`  HDR（${job.hdr}）逐位对照 ${refLabel}${job.hdrMask ? `，非遮罩区 = ${job.hdrMask} 与参照逐位相同的像素` : ""}：`);
        for (const [l, r] of Object.entries(hdrCmp)) console.log(`    ${l}: 不同像素 ${r.diffPx}，最大差 ${r.maxAbs.toExponential(3)}${r.nonMaskPx !== undefined ? `；非遮罩区 ${r.nonMaskPx} 像素中不同 ${r.nonMaskDiffPx}，最大 ${r.nonMaskMax.toExponential(3)}` : ""}`);
      }
      for (const s of shots) if (s.bench) console.log(`  ${s.label}: ${s.bench.fn}(30) 中位 ${s.bench.median} ms / 最小 ${s.bench.min} ms`);
      summary.push({ job: job.name, scene: sc.name, crop: job.crop || null, ref: refLabel, shots, metrics, noise, hdr: hdrCmp, cloud: cloudRes, live });
      fs.writeFileSync(path.join(outDir, "summary.json"), JSON.stringify(summary, null, 2));
    }
    const tileNote = tileErrors.n ? `；EOX 瓦片跨域 / 加载失败共 ${tileErrors.n} 条（已聚合，每张图的 corsErrors 见 json）` : "";
    log(`完成，输出 ${path.relative(REPO_ROOT, outDir).replace(/\\/g, "/")}/summary.json；console error ${errors.length} 条${tileNote}`);
    for (const e of errors.slice(0, 5)) console.error(`  [${e.type}] ${e.text.slice(0, 300)}`);
    return summary;
  } finally {
    await h.closeBrowserSafely(browser);
    release();
  }
}

// ---------- flight：确定性航迹重放（云的时间行为） ----------
// 在页面里完全冻结（云也不由 rAF 渲染），由脚本手动调用 clouds.render(motion, camBasis, c2w) 推进云，航迹逐位可复现；
// 每个变体走同一条航迹。真值 = 同姿态静止、逐帧 raw（resolve 之前、未夹取的本帧步进结果）等权平均 --truth 帧——
// 不依赖 resolve 着色器的文本（C12b-ab.mjs 靠文本替换做 truth 变体，resolve 一改就失配），对任何变体都成立。
function installFlightLib() {
  const v = window.__voyage;
  const u = v.sceneMat.uniforms;
  const L = {};
  L.cropRect = (crop) => {
    const t = v.clouds.history[0];
    const CW = t.width / 2, CH = t.height;
    const cv = document.querySelector("canvas");
    const sx = CW / cv.clientWidth, sy = CH / cv.clientHeight;
    const x = Math.round(crop[0] * sx), w = Math.max(1, Math.round(crop[2] * sx)), h = Math.max(1, Math.round(crop[3] * sy));
    const y = Math.round(CH - (crop[1] + crop[3]) * sy);
    return { x, y, w, h };
  };
  const readLumOf = (t, r) => {
    const buf = new Float32Array(r.w * r.h * 4);
    v.clouds.pass.renderer.readRenderTargetPixels(t, r.x, r.y, r.w, r.h, buf);
    const out = new Float32Array(r.w * r.h);
    for (let k = 0; k < out.length; k++) out[k] = 0.2126 * buf[4 * k] + 0.7152 * buf[4 * k + 1] + 0.0722 * buf[4 * k + 2];
    return out;
  };
  L.readLum = (r) => readLumOf(v.clouds.history[0], r);
  L.readRaw = (r) => readLumOf(v.clouds.raw, r);
  L.b64 = (f32) => {
    const u8 = new Uint8Array(f32.buffer);
    let s = "";
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return btoa(s);
  };
  L.savePose = () => {
    L.pose0 = { off: v.cloudUniforms.uCloudOffset.value.clone(), c2w: u.uCabinToWorld.value.clone(), camR: u.uCamR.value, imm: v.clouds.resolveMat.uniforms.uCloudImmersion.value, heading: v.state.heading };
  };
  L.setPose = (p) => {
    v.cloudUniforms.uCloudOffset.value.copy(p.off);
    u.uCabinToWorld.value.copy(p.c2w);
    u.uCamR.value = p.camR;
    v.clouds.resolveMat.uniforms.uCloudImmersion.value = p.imm;
  };
  L.zero = () => v.clouds.resolveMat.uniforms.uMotion.value.clone().set(0, 0, 0);
  L.render = (motion) => v.clouds.render(motion, u.uCamBasis.value, u.uCabinToWorld.value);
  L.finish = () => { u.uClouds.value = v.clouds.texture; };
  /** 真值：pose 上静止，逐帧 raw 等权平均 n 帧（uFrame 周期 64，n 取 64 的倍数最干净） */
  L.truth = (pose, r, n) => {
    L.setPose(pose);
    const z = L.zero();
    const acc = new Float64Array(r.w * r.h);
    v.clouds.frame = 0;
    v.clouds.snap();
    for (let i = 0; i < n; i++) {
      L.render(z);
      const f = L.readRaw(r);
      for (let k = 0; k < acc.length; k++) acc[k] += f[k];
    }
    const out = new Float32Array(acc.length);
    for (let k = 0; k < acc.length; k++) out[k] = acc[k] / n;
    return out;
  };
  const rot = (M3, axis, ang) => {
    const [x, y, z] = axis, c = Math.cos(ang), s = Math.sin(ang), t = 1 - c;
    const m = new M3();
    m.set(t * x * x + c, t * x * y - s * z, t * x * z + s * y, t * x * y + s * z, t * y * y + c, t * y * z - s * x, t * x * z - s * y, t * y * z + s * x, t * z * z + c);
    return m;
  };
  /** 一条确定性航迹（cruise / turn / exit），在检查点回调；返回各检查点姿态 */
  L.fly = (mode, P, onCheck) => {
    const p0 = L.pose0;
    L.setPose(p0);
    const M3 = p0.c2w.constructor;
    const h = (p0.heading * Math.PI) / 180;
    if (mode === "turn") u.uCabinToWorld.value.premultiply(rot(M3, [Math.sin(h), 0, -Math.cos(h)], (P.roll * Math.PI) / 180));
    const motion = L.zero();
    const poses = {};
    v.clouds.frame = 0;
    v.clouds.snap();
    L.render(motion);
    let hd = h;
    const top = v.cloudUniforms.uCloudTop ? v.cloudUniforms.uCloudTop.value : undefined;
    let exitAt = null;
    for (let k = 1; k <= P.frames; k++) {
      if (mode === "turn") {
        hd += (P.yaw * Math.PI) / 180;
        u.uCabinToWorld.value.premultiply(rot(M3, [0, 1, 0], (-P.yaw * Math.PI) / 180));
      }
      const dx = Math.sin(hd) * P.speed, dz = -Math.cos(hd) * P.speed;
      v.cloudUniforms.uCloudOffset.value.x += dx;
      v.cloudUniforms.uCloudOffset.value.y += dz;
      let dy = 0;
      if (mode === "exit") {
        dy = P.climb;
        u.uCamR.value += dy;
        const imm = v.clouds.resolveMat.uniforms.uCloudImmersion;
        if (top !== undefined && u.uCamR.value - 6360 > top + 0.05) {
          if (exitAt === null) exitAt = k;
          imm.value *= Math.exp(-1 / 60 / 0.5); // 出云后 whiteout 按 τ = 0.5 s 衰减（同 C12b-ab.mjs）
        }
      }
      L.render(motion.set(dx, dy, dz));
      if (P.checks.includes(k)) {
        poses[k] = { off: v.cloudUniforms.uCloudOffset.value.clone(), c2w: u.uCabinToWorld.value.clone(), camR: u.uCamR.value, imm: v.clouds.resolveMat.uniforms.uCloudImmersion.value, exitAt };
        onCheck(k);
      }
    }
    return poses;
  };
  window.__dxf = L;
}

// Node 侧的 HDR 指标（C12b-metrics.py 的口径，改写成 JS）
function gk(s) {
  if (s < 0.05) return [1];
  const r = Math.ceil(3 * s) + 1;
  const k = [];
  for (let x = -r; x <= r; x++) k.push(Math.exp(-0.5 * (x / s) ** 2));
  const sum = k.reduce((a, b) => a + b, 0);
  return k.map((x) => x / sum);
}
function blur1(A, w, h, s, axis) {
  const k = gk(s);
  if (k.length === 1) return A;
  const r = (k.length - 1) / 2;
  const out = new Float32Array(A.length);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let i = 0; i < k.length; i++) {
        let xx = x, yy = y;
        if (axis === 0) xx = Math.min(w - 1, Math.max(0, x + i - r));
        else yy = Math.min(h - 1, Math.max(0, y + i - r));
        acc += k[i] * A[yy * w + xx];
      }
      out[y * w + x] = acc;
    }
  return out;
}
function box3(A, w, h) {
  const out = new Float32Array(A.length);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) s += A[Math.min(h - 1, Math.max(0, y + dy)) * w + Math.min(w - 1, Math.max(0, x + dx))];
      out[y * w + x] = s / 9;
    }
  return out;
}
function grad2(A, w, h) {
  const g = new Float32Array(A.length);
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++) {
      const gx = (A[y * w + x + 1] - A[y * w + x - 1]) / 2, gy = (A[(y + 1) * w + x] - A[(y - 1) * w + x]) / 2;
      g[y * w + x] = gx * gx + gy * gy;
    }
  return g;
}
/** V（变体）对 T（真值）：err = rms(V−T)/mean(T)；σx/σy = 拟合 V ≈ G(σx,σy)⊗T 的等效模糊（像素，云边宽度）；
 * edge = 云边带（T 梯度前 10%）上 box3 后梯度能量 V/T（1 = 同样锐，< 1 变糊） */
export function hdrMetrics(V, T, w, h, { fitSigma = true } = {}) {
  let mu = 0;
  for (let i = 0; i < T.length; i++) mu += T[i];
  mu = Math.max(mu / T.length, 1e-9);
  let e = 0;
  for (let i = 0; i < T.length; i++) e += (V[i] - T[i]) ** 2;
  const err = Math.sqrt(e / T.length) / mu;
  const gT = grad2(box3(T, w, h), w, h), gV = grad2(box3(V, w, h), w, h);
  const sorted = Float32Array.from(gT).sort();
  const thr = sorted[Math.floor(0.9 * sorted.length)];
  let sT = 0, sV = 0;
  for (let i = 0; i < gT.length; i++) if (gT[i] > thr) { sT += gT[i]; sV += gV[i]; }
  const edge = sV / Math.max(sT, 1e-30);
  let sx = null, sy = null, resid = null;
  if (fitSigma) {
    const m = 4;
    const rmsOf = (B) => {
      let s = 0, n = 0;
      for (let y = m; y < h - m; y++) for (let x = m; x < w - m; x++) { s += (B[y * w + x] - V[y * w + x]) ** 2; n++; }
      return s / Math.max(1, n);
    };
    const S = [0, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3];
    const Tx = S.map((s) => blur1(T, w, h, s, 0));
    let best = [Infinity, 0, 0];
    for (let i = 0; i < S.length; i++) for (const syv of S) {
      const r = rmsOf(blur1(Tx[i], w, h, syv, 1));
      if (r < best[0]) best = [r, S[i], syv];
    }
    [resid, sx, sy] = [Math.sqrt(best[0]) / mu, best[1], best[2]];
  }
  return { err: +err.toFixed(5), sx, sy, resid: resid == null ? null : +resid.toFixed(5), edge: +edge.toFixed(4) };
}

const f32From = (b64) => { const b = Buffer.from(b64, "base64"); return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4); };

export async function cmdFlight(args, h) {
  const { REPO_ROOT, openPage, launchBrowser, setFlashDisabled, setWingStrobe, resolveBaseShaderSource, parseViewport, parseDpr, parseExtraQuery, setQualityTier, log } = h;
  const port = args.port;
  if (!port) throw new Error("flight 需要 --port <端口>");
  const angle = String(args.angle || "d3d11");
  const viewport = parseViewport(args);
  const dpr = parseDpr(args);
  const jobs = readJson(REPO_ROOT, args.jobs, "--jobs");
  const variants = args.variants ? readJson(REPO_ROOT, args.variants, "--variants") : [{ name: "current" }];
  validateVariants(variants, "--variants");
  const MODES = String(args.modes || "static,reset,cruise").split(",");
  const KNOWN = ["static", "reset", "cruise", "turn", "exit", "live"];
  for (const m of MODES) if (!KNOWN.includes(m)) throw new Error(`--modes 不认识 "${m}"（可选 ${KNOWN.join(",")}）`);
  const P = {
    warm: Number(args.warm || 96),
    ns: Number(args.frames || 64),
    truth: Number(args.truth || 128),
    speed: Number(args.speed || 0.004), // km / 帧（约 240 m/s、60 fps）
    mframes: Number(args.mframes || 160),
    checks: String(args.checks || "100,120,140,160").split(",").map(Number),
    roll: Number(args.roll || 25),
    yaw: Number(args.yaw || 0.05), // °/帧（0.05°/帧 = 3°/s）
    climb: Number(args.climb || 0.002),
    liveFrames: Number(args["live-frames"] || 96),
  };
  const fitSigma = !args["no-sigma"];
  const outDir = resolveRepoPath(REPO_ROOT, args.out || `tmp/screenshot/flight-${port}`);
  fs.mkdirSync(outDir, { recursive: true });

  const release = await acquireMeasureLock(REPO_ROOT, `dev-browser.mjs flight（端口 ${port}, pid ${process.pid}）`, log);
  const browser = await launchBrowser(angle);
  const summary = [];
  try {
    const baseSource = async (matPath) => {
      if (!args.base) throw new Error(`变体里有来源 "base"，需要 --base <对照端口>`);
      return resolveBaseShaderSource(String(args.base), matPath, { browser, angle });
    };
    const resolved = await resolveSources(variants, { baseSource, repoRoot: REPO_ROOT });
    const { page, renderer, errors, tileErrors } = await openPage(browser, port, angle, viewport, dpr, { collectErrors: true, extraQuery: parseExtraQuery(args) });
    log(`flight --angle=${angle}  GL_RENDERER = ${renderer}  模式 ${MODES.join(",")}`);
    await setQualityTier(page, args.quality);
    await setFlashDisabled(page, true);
    await page.evaluate(installVariantLib);
    await page.evaluate(installFlightLib);
    for (const job of jobs) {
      if (!job.name || !job.crop) throw new Error("flight 的每个 job 都要有 name 与 crop [x,y,w,h]（显示像素，换算到云缓冲）");
      const sc = sceneOf(job);
      await page.evaluate(applyScene, { sc, defaults: DEFAULTS, settle: false });
      await page.evaluate(pinGeometry, sc);
      await raf(page, 30);
      await page.evaluate(() => window.__voyage.freeze(true)); // 全冻结：云只由下面的手动 render 推进，航迹逐位可复现
      await setWingStrobe(page, 0);
      // G-FREEZE：带地面的场景冻结后等地面完全稳定（与 ab / gpu-ab 同一判据），否则各变体之间地面可能换版
      if (sc.ground) {
        const st = await groundSettle(page, 120000);
        if (!st.ok) log(`  [警告] ${job.name}：等地面稳定超时（${st.reason}）`);
      }
      await raf(page, 2);
      await page.evaluate(() => window.__dxf.savePose());
      const { mats, unis } = collectPaths(variants);
      await page.evaluate(({ mats, unis }) => window.__dx.prepare(mats, unis), { mats, unis });
      const key = await page.evaluate(() => window.__voyage.clouds.marchShown);
      const row = { job: job.name, marchKey: key, crop: job.crop, variants: {} };
      const jdir = path.join(outDir, job.name);
      fs.mkdirSync(jdir, { recursive: true });
      for (const va of resolved) {
        const e0 = errors.length;
        await page.evaluate((va) => window.__dx.apply(va), va);
        const res = {};
        if (MODES.includes("static")) {
          const st = await page.evaluate(({ crop, P }) => {
            const L = window.__dxf, v = window.__voyage;
            const r = L.cropRect(crop);
            const T = L.truth(L.pose0, r, P.truth);
            L.setPose(L.pose0);
            const z = L.zero();
            v.clouds.frame = 0;
            v.clouds.snap();
            for (let i = 0; i < P.warm; i++) L.render(z);
            const N = r.w * r.h, BX = 16, series = [];
            for (let f = 0; f < P.ns; f++) { L.render(z); series.push(L.readLum(r)); }
            let sStd = 0, sLow = 0, cnt = 0, sp2 = 0, spM = 0, eT = 0, muT = 0;
            for (let k = 0; k < N; k++) {
              let mm = 0;
              for (let f = 0; f < P.ns; f++) mm += series[f][k];
              mm /= P.ns;
              eT += (series[P.ns - 1][k] - T[k]) ** 2;
              muT += T[k];
              if (!(mm > 0.02)) continue;
              let s2 = 0;
              for (let f = 0; f < P.ns; f++) s2 += (series[f][k] - mm) ** 2;
              let l2 = 0, nb = 0;
              for (let f0 = 0; f0 + BX <= P.ns; f0 += BX) { let a = 0; for (let f = f0; f < f0 + BX; f++) a += series[f][k]; a /= BX; l2 += (a - mm) ** 2; nb++; }
              sStd += Math.sqrt(s2 / P.ns) / mm;
              sLow += nb ? Math.sqrt(l2 / nb) / mm : 0;
              sp2 += (series[P.ns - 1][k] - mm) ** 2;
              spM += mm;
              cnt++;
            }
            muT = Math.max(muT / N, 1e-9);
            L.finish();
            return { px: cnt, w: r.w, h: r.h, relStd: +(sStd / Math.max(cnt, 1)).toFixed(5), relLow16: +(sLow / Math.max(cnt, 1)).toFixed(5), spatRms: +(Math.sqrt(sp2 / Math.max(cnt, 1)) / Math.max(spM / Math.max(cnt, 1), 1e-9)).toFixed(5), errTruth: +(Math.sqrt(eT / N) / muT).toFixed(5), meanHdr: +muT.toFixed(5), last: L.b64(series[P.ns - 1]), truth: L.b64(T) };
          }, { crop: job.crop, P });
          const md = path.join(jdir, "static", va.name);
          fs.mkdirSync(md, { recursive: true });
          fs.writeFileSync(path.join(md, "last.f32"), Buffer.from(st.last, "base64"));
          fs.writeFileSync(path.join(md, "truth.f32"), Buffer.from(st.truth, "base64"));
          const m = hdrMetrics(f32From(st.last), f32From(st.truth), st.w, st.h, { fitSigma });
          delete st.last;
          delete st.truth;
          res.static = { ...st, sx: m.sx, sy: m.sy, edge: m.edge };
        }
        if (MODES.includes("reset")) {
          // reset 后收敛（C12b 审查、DEV_SOP 时间累积三条之①）：静止姿态 snap() 后第 k 帧对真值的相对 rms 误差，3 个 uFrame 起点平均
          res.reset = await page.evaluate(({ crop, P }) => {
            const L = window.__dxf, v = window.__voyage;
            const r = L.cropRect(crop);
            const T = L.truth(L.pose0, r, P.truth);
            let mu = 0;
            for (let i = 0; i < T.length; i++) mu += T[i];
            mu = Math.max(mu / T.length, 1e-9);
            const K = [1, 2, 4, 8, 16, 24, 32, 48, 64];
            const acc = K.map(() => 0);
            const starts = [0, 21, 43];
            L.setPose(L.pose0);
            const z = L.zero();
            for (const s0 of starts) {
              v.clouds.frame = s0;
              v.clouds.snap();
              L.render(z);
              for (let k = 1; k <= 64; k++) {
                L.render(z);
                const ki = K.indexOf(k);
                if (ki >= 0) {
                  const V = L.readLum(r);
                  let e = 0;
                  for (let i = 0; i < V.length; i++) e += (V[i] - T[i]) ** 2;
                  acc[ki] += Math.sqrt(e / V.length) / mu / starts.length;
                }
              }
            }
            L.finish();
            return Object.fromEntries(K.map((k, i) => [k, +acc[i].toFixed(4)]));
          }, { crop: job.crop, P });
        }
        for (const mode of ["cruise", "turn", "exit"]) {
          if (!MODES.includes(mode)) continue;
          const PP = { ...P, frames: job.mframes ?? P.mframes, checks: job.checks ?? P.checks, speed: job.speed ?? P.speed, climb: job.climb ?? P.climb };
          const out = await page.evaluate(({ mode, P, crop }) => {
            const L = window.__dxf;
            const r = L.cropRect(crop);
            const shots = {};
            const poses = L.fly(mode, P, (k) => { shots[k] = L.b64(L.readLum(r)); });
            const truths = {};
            for (const k of Object.keys(poses)) truths[k] = L.b64(L.truth(poses[k], r, P.truth));
            L.setPose(L.pose0);
            L.finish();
            const meta = {};
            for (const k of Object.keys(poses)) meta[k] = { imm: poses[k].imm, exitAt: poses[k].exitAt };
            return { w: r.w, h: r.h, shots, truths, meta };
          }, { mode, P: PP, crop: job.crop });
          const md = path.join(jdir, mode, va.name);
          fs.mkdirSync(md, { recursive: true });
          const per = {};
          for (const k of Object.keys(out.shots)) {
            fs.writeFileSync(path.join(md, `cp${k}.f32`), Buffer.from(out.shots[k], "base64"));
            fs.writeFileSync(path.join(md, `truth${k}.f32`), Buffer.from(out.truths[k], "base64"));
            per[k] = { ...hdrMetrics(f32From(out.shots[k]), f32From(out.truths[k]), out.w, out.h, { fitSigma }), ...out.meta[k] };
          }
          const vals = Object.values(per);
          const avg = (f) => { const xs = vals.map((x) => x[f]).filter((x) => x != null); return xs.length ? +(xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(4) : null; };
          res[mode] = { err: avg("err"), errMax: +Math.max(...vals.map((x) => x.err)).toFixed(4), sx: avg("sx"), sy: avg("sy"), resid: avg("resid"), edge: avg("edge"), per };
        }
        if (MODES.includes("live")) {
          // 页内逐帧 readPixels（DEV_SOP 时间累积三条之②：运动 / 抖动不能用逐帧截图测）：解冻、飞机照常飞，
          // 每个 rAF 紧跟主循环之后读显示画布的裁剪区（主循环的 rAF 回调先注册，同一帧里先执行，读到的是刚画完的一帧）
          await page.evaluate(() => window.__voyage.freeze(false));
          await raf(page, 30);
          res.live = await page.evaluate(async ({ crop, n }) => {
            const cv = document.querySelector("canvas");
            const gl = cv.getContext("webgl2");
            const sx = gl.drawingBufferWidth / cv.clientWidth, sy = gl.drawingBufferHeight / cv.clientHeight;
            const w = Math.round(crop[2] * sx), h = Math.round(crop[3] * sy);
            const x = Math.round(crop[0] * sx), y = gl.drawingBufferHeight - Math.round((crop[1] + crop[3]) * sy);
            const buf = new Uint8Array(w * h * 4);
            const TS = 16, tw = Math.floor(w / TS), th = Math.floor(h / TS);
            const tiles = [], means = [], dts = [];
            let last = performance.now();
            for (let i = 0; i < n; i++) {
              const now = await new Promise((res) => requestAnimationFrame(res));
              gl.bindFramebuffer(gl.FRAMEBUFFER, null);
              gl.readPixels(x, y, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
              const t = new Float32Array(tw * th);
              let sum = 0;
              for (let yy = 0; yy < th * TS; yy++) for (let xx = 0; xx < tw * TS; xx++) {
                const k = (yy * w + xx) * 4;
                const l = 0.2126 * buf[k] + 0.7152 * buf[k + 1] + 0.0722 * buf[k + 2];
                sum += l;
                t[Math.floor(yy / TS) * tw + Math.floor(xx / TS)] += l / (TS * TS);
              }
              tiles.push(t);
              means.push(sum / (tw * th * TS * TS));
              dts.push(now - last);
              last = now;
            }
            // 画面在动，内容本身在变：先减去 8 帧滑动平均（去掉内容漂移），剩下的才算抖动
            const detr = (arr, j) => { let a = 0, c = 0; for (let q = Math.max(0, j - 4); q <= Math.min(arr.length - 1, j + 4); q++) { a += arr[q]; c++; } return a / c; };
            let sStd = 0, sLow = 0, cnt = 0;
            for (let k = 0; k < tw * th; k++) {
              const s = tiles.map((t) => t[k]);
              const m = s.reduce((a, b) => a + b, 0) / s.length;
              if (m < 3) continue;
              const hp = s.map((x, j) => x - detr(s, j));
              sStd += Math.sqrt(hp.reduce((a, b) => a + b * b, 0) / hp.length) / m;
              let l2 = 0, nb = 0;
              for (let f0 = 0; f0 + 16 <= s.length; f0 += 16) { let a = 0; for (let f = f0; f < f0 + 16; f++) a += s[f]; a /= 16; l2 += (a - m) ** 2; nb++; }
              sLow += nb ? Math.sqrt(l2 / nb) / m : 0;
              cnt++;
            }
            const mm = means.reduce((a, b) => a + b, 0) / means.length;
            let d1 = 0;
            for (let i = 1; i < means.length; i++) d1 += Math.abs(means[i] - means[i - 1]);
            const sdt = [...dts.slice(1)].sort((a, b) => a - b);
            return { frames: n, tiles: cnt, relStd: +(sStd / Math.max(cnt, 1)).toFixed(5), relLow16: +(sLow / Math.max(cnt, 1)).toFixed(5), breath: +(d1 / (means.length - 1) / Math.max(mm, 1e-9)).toFixed(5), meanLuma: +mm.toFixed(2), dtMedian: +sdt[Math.floor(sdt.length / 2)].toFixed(2), dtMax: +sdt[sdt.length - 1].toFixed(2) };
          }, { crop: job.crop, n: P.liveFrames });
          // 回到冻结与起点姿态，给下一个变体（live 模式本身不可逐位复现，只看统计量）
          await page.evaluate(applyScene, { sc, defaults: DEFAULTS, settle: false });
          await page.evaluate(pinGeometry, sc);
          await page.evaluate(() => { window.__voyage.freeze(true); window.__dxf.savePose(); });
        }
        res.errors = errors.length - e0;
        row.variants[va.name] = res;
        log(`${job.name} / ${va.name}：${JSON.stringify({ ...res, cruise: res.cruise && { ...res.cruise, per: undefined }, turn: res.turn && { ...res.turn, per: undefined }, exit: res.exit && { ...res.exit, per: undefined } })}`);
      }
      await page.evaluate(() => { window.__dx.restore(); window.__voyage.clouds.snap(); window.__voyage.freeze(false); });
      await setWingStrobe(page, null);
      summary.push(row);
      fs.writeFileSync(path.join(outDir, "summary.json"), JSON.stringify({ modes: MODES, params: P, variants, rows: summary }, null, 2));
      printFlightTable(row, MODES);
    }
    const tileNote = tileErrors.n ? `；EOX 瓦片跨域 / 加载失败 ${tileErrors.n} 条（已聚合）` : "";
    log(`完成，输出 ${path.relative(REPO_ROOT, outDir).replace(/\\/g, "/")}/summary.json；console error ${errors.length} 条${tileNote}`);
    for (const e of errors.slice(0, 5)) console.error(`  [${e.type}] ${e.text.slice(0, 300)}`);
    return summary;
  } finally {
    await h.closeBrowserSafely(browser);
    release();
  }
}

function printFlightTable(row, MODES) {
  console.log(`\n== ${row.job}（步进变体 ${row.marchKey || "默认"}，裁剪 ${row.crop.join(",")}；err = rms(V−真值)/均值，σ = 等效模糊 px，edge = 云边梯度能量比）`);
  const names = Object.keys(row.variants);
  const base = names[0];
  for (const n of names) {
    const r = row.variants[n];
    const parts = [];
    if (r.static) parts.push(`静止 relStd ${r.static.relStd} low16 ${r.static.relLow16} spat ${r.static.spatRms} err ${r.static.errTruth} σ ${r.static.sx}/${r.static.sy} edge ${r.static.edge}`);
    if (r.reset) parts.push(`reset err@1/4/16/64 ${r.reset[1]}/${r.reset[4]}/${r.reset[16]}/${r.reset[64]}`);
    for (const m of ["cruise", "turn", "exit"]) if (r[m]) parts.push(`${m} err ${r[m].err}(峰 ${r[m].errMax}) σ ${r[m].sx}/${r[m].sy} edge ${r[m].edge}`);
    if (r.live) parts.push(`live relStd ${r.live.relStd} low16 ${r.live.relLow16} 呼吸 ${r.live.breath} dt 中位 ${r.live.dtMedian} ms`);
    console.log(`  ${n.padEnd(12)} ${parts.join(" | ")}${r.errors ? `  [console error ${r.errors}]` : ""}`);
  }
  if (names.length > 1) {
    const ratio = (a, b) => (a != null && b ? `×${(a / b).toFixed(3)}` : "—");
    for (const n of names.slice(1)) {
      const r = row.variants[n], b = row.variants[base];
      const parts = [];
      if (r.static) parts.push(`静止 relStd ${ratio(r.static.relStd, b.static.relStd)} err ${ratio(r.static.errTruth, b.static.errTruth)}`);
      if (r.reset) parts.push(`reset@16 ${ratio(r.reset[16], b.reset[16])}`);
      for (const m of ["cruise", "turn", "exit"]) if (r[m]) parts.push(`${m} err ${ratio(r[m].err, b[m].err)} edge ${ratio(r[m].edge, b[m].edge)}`);
      if (r.live) parts.push(`live relStd ${ratio(r.live.relStd, b.live.relStd)}`);
      console.log(`  ${n} / ${base}：${parts.join("  ")}`);
    }
  }
  void MODES;
}
