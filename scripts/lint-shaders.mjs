#!/usr/bin/env node
// DX-02：离线 GLSL 检查（不开浏览器）。
//
// 做两件事：
// 1. 用 vite 的 ssrLoadModule 在 Node 里直接调用各着色器材质的构造函数（场景、场景的 GROUND_DETAIL 变体、
//    机翼、云的三个 pass、云噪声、海浪 FFT、眩光、曝光、大气 LUT），拼出完整的顶点 / 片元着色器源码，
//    交给 glslangValidator 做语法校验。
// 2. 两项静态检查，直接在「已经拼好的整份程序文本」上做（和 1. 共用同一份数据，不是分别扫源文件）：
//    a. 同一个程序里的「同签名函数重名」——GLSL 没有命名空间，所有拼进同一个程序的片段如果有函数重名会编译失败，
//       而且只在某个变体把相关模块凑齐时才暴露（见 README 坑点，T02 × T06 的 lineCov 撞名就是这样漏过去的）。
//       按「已拼好的程序」而不是「按源文件」扫，是为了避免不同程序各自的 main() 互相「撞名」的假阳性——
//       它们从来不会被编进同一个程序，不是真的重名。
//    b. 场景程序的 sampler 数（ANGLE 上 MAX_TEXTURE_IMAGE_UNITS = 16，见 README 坑点）。这里只能做「声明了但从没
//       被引用过」这一层过滤（也处理了 GROUND_DETAIL 宏：默认变体会先把 #ifdef GROUND_DETAIL 块整体挖掉再数，
//       不然会把只在低空细节变体里用到的 sampler 也算进默认变体），不是真正的链接期 active uniform 统计，
//       所以只是比「原始声明数」更准的近似，不是 100%精确——真正精确的数字仍要用 dev-browser.mjs 起一个真实
//       WebGL2 上下文，读 `gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS)`。
//
// 用法（必须在 apps/voyage 目录树内跑，Node 的 ESM 解析从脚本所在目录向上找 node_modules 才能找到 vite）：
//   pnpm --filter voyage check:glsl
//
// 已知局限（开发体验官 DX_REPORT_wave2.md §1.3 的结论，这里仍然成立）：
// - glslangValidator 校验的是标准 GLSL ES 3.00 语义，不会重现 ANGLE → FXC 的 Windows 专属问题
//   （分支/循环里的屏幕导数 X3595、FXC 展开常量循环导致冷编译暴涨）。这两类坑还是要靠冷编译计时
//   （scripts/dev-browser.mjs cold）或代码审查抓。
// - THREE 的 `#include <chunk>` 是渲染器在真正编译时注入的，我们绕过了 three 的编译管线直接读 `.fragmentShader`
//   字符串，所以这里用手写的桩替换（INCLUDE_STUBS）而不是 THREE.ShaderChunk 的原文——试过直接展开 THREE 自己的
//   `common` chunk，glslangValidator 会对其中的 `average()` 函数名报「redeclaration of existing name」，
//   这是 glslangValidator 自身符号表的误报（ANGLE / 真实浏览器编译这份 chunk 完全正常，three.js 到处在用），
//   跟 voyage 的代码无关。用桩替换后只校验 voyage 自己写的部分，绕开这个误报。

import { createServer } from "vite";
import * as THREE from "three";
import glslangPkg from "glslang-validator-prebuilt-predownloaded";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SCENES } from "./scenarios.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const VOYAGE_ROOT = path.join(SCRIPT_DIR, "..");

// ---------- 通用 mock 工具 ----------

/** 任意深度的链式访问都返回另一个 mock（够用来喂 `atmosphere.aerialInscatter.texture` 这类链式读取） */
function deepMock() {
  const store = {};
  return new Proxy(store, {
    get(target, prop) {
      if (typeof prop === "symbol" || prop === "then") return undefined;
      if (!(prop in target)) target[prop] = deepMock();
      return target[prop];
    },
  });
}

/** 拦截 FullscreenPass.render(material, target) 的传参，收集材质对象本身（去重）；不做任何真正的渲染 */
function capturingPass() {
  const seen = new Set();
  const mats = [];
  const pass = {
    render(material) {
      if (material && !seen.has(material)) {
        seen.add(material);
        mats.push(material);
      }
    },
  };
  return { pass, mats };
}

// ---------- 枚举全部程序 ----------

async function collectPrograms(server) {
  const programs = [];
  const add = (id, mat) => {
    if (!mat || typeof mat.fragmentShader !== "string") throw new Error(`${id}：拿到的不是一个 ShaderMaterial`);
    programs.push({ id, fragmentShader: mat.fragmentShader, vertexShader: mat.vertexShader });
  };

  // 场景（默认变体）+ 场景的 GROUND_DETAIL 变体（同一份 fragmentShader 源码，GROUND_DETAIL 变体只是多一个
  // three 在编译期注入的 #define GROUND_DETAIL 1，这里手动补上，不走 GroundDetailVariant.prepare()
  // ——那个方法要真的调用 renderer.compileAsync，离线检查没有真实 GPU）
  {
    const m = await server.ssrLoadModule("/src/render/scene.ts");
    const ground = { albedo: null, water: null, height: null, levelUniform: [] };
    const mat = m.createSceneMaterial(deepMock(), {}, ground);
    add("scene-default", mat);
    programs.push({
      id: "scene-ground-detail",
      fragmentShader: "#define GROUND_DETAIL 1\n" + mat.fragmentShader,
      vertexShader: mat.vertexShader,
    });
  }

  // 机翼 pass
  {
    const m = await server.ssrLoadModule("/src/render/wing-pass.ts");
    add("wing", m.createWingMaterial({}));
  }

  // 云：光线步进 / 密度探针 / 时间累积解析，三个都是构造函数里直接赋的实例字段（TS 的 private 只在编译期存在，
  // 运行时 vite/esbuild 已经抹掉，直接读字段就行，不用真的渲染）
  {
    const m = await server.ssrLoadModule("/src/clouds/clouds.ts");
    const { pass } = capturingPass();
    const clouds = new m.Clouds(pass, deepMock(), {}, {});
    add("cloud-march", clouds.marchMat);
    add("cloud-probe", clouds.probeMat);
    add("cloud-resolve", clouds.resolveMat);
  }

  // 云噪声：generateCloudNoise 会真的调用 pass.render + renderer.readRenderTargetPixels 做读回，
  // 这里的 pass/renderer 都是空转的 mock，只借它的调用时机把材质对象截下来
  {
    const m = await server.ssrLoadModule("/src/clouds/noise.ts");
    const { pass, mats } = capturingPass();
    const renderer = { setScissorTest() {}, readRenderTargetPixels() {} };
    await m.generateCloudNoise(renderer, pass);
    mats.forEach((mat, i) => add(`cloud-noise-${i}`, mat));
  }

  // 海浪 FFT：三个 pass 材质也是实例字段，构造函数不会调用 pass.render（要 .update() 才会），直接读字段
  {
    const m = await server.ssrLoadModule("/src/ocean/waves.ts");
    const renderer = { capabilities: { getMaxAnisotropy: () => 1 }, initRenderTarget() {} };
    const waves = new m.OceanWaves(renderer);
    add("ocean-evolve", waves.evolve);
    add("ocean-butterfly", waves.butterfly);
    add("ocean-finalize", waves.finalize);
  }

  // 眩光（下采样 / 上采样累加）
  {
    const m = await server.ssrLoadModule("/src/render/bloom.ts");
    const bloom = new m.Bloom({ render() {} }, THREE.HalfFloatType);
    add("bloom-down", bloom.downMat);
    add("bloom-up", bloom.upMat);
  }

  // 曝光 / 人眼式自动曝光 / AgX 色调映射
  {
    const m = await server.ssrLoadModule("/src/render/exposure.ts");
    const exposure = new m.Exposure({ render() {} });
    add("exposure-meter", exposure.meterMat);
    add("exposure-adapt", exposure.adaptMat);
    add("exposure-final", exposure.finalMat);
  }

  // 大气 LUT：transmittance / multi-scattering / irradiance 是构造函数里的匿名材质，从没存成字段，
  // 只能靠拦截 pass.render 截下来；skyView / aerial 是实例字段，直接读
  {
    const m = await server.ssrLoadModule("/src/atmosphere/luts.ts");
    const { pass, mats } = capturingPass();
    const atmosphere = new m.Atmosphere(pass);
    mats.forEach((mat, i) => add(`atmosphere-lut-${i}`, mat));
    add("atmosphere-sky-view", atmosphere.skyViewMaterial);
    add("atmosphere-aerial", atmosphere.aerialMaterial);
  }

  return programs;
}

// ---------- glslangValidator 语法校验 ----------

const INCLUDE_STUBS = {
  // THREE 的 #include <chunk> 由渲染器编译期注入，这里手写桩替换（原因见文件头注释）
  common: "",
  dithering_pars_fragment: "",
  tonemapping_fragment: "",
  colorspace_fragment: "gl_FragColor = linearToOutputTexel(gl_FragColor);",
  dithering_fragment: "#ifdef DITHERING\n  gl_FragColor.rgb = dithering(gl_FragColor.rgb);\n#endif",
};
const INCLUDE_RE = /^[ \t]*#include +<([\w.\/]+)>/gm;
function resolveIncludes(src, unknown) {
  return src.replace(INCLUDE_RE, (m, name) => {
    if (!(name in INCLUDE_STUBS)) {
      unknown.add(name);
      return "";
    }
    return INCLUDE_STUBS[name];
  });
}

const FRAG_PREFIX = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler3D;
precision highp sampler2DArray;
out highp vec4 pc_fragColor;
#define gl_FragColor pc_fragColor
#define varying in
#define texture2D texture
#define saturate(a) clamp(a, 0.0, 1.0)
vec3 dithering(vec3 c) { return c; }
vec4 linearToOutputTexel(vec4 v) { return v; }
vec3 toneMapping(vec3 c) { return c; }
`;

const VERT_PREFIX = `#version 300 es
precision highp float;
in vec3 position;
in vec2 uv;
in vec3 normal;
#define varying out
`;

function glslangBin() {
  return glslangPkg.getPath();
}

/** 对一份已经拼好前缀的源码跑 glslangValidator，返回 { ok, output } */
function validate(bin, tmpDir, filename, stage, source) {
  const file = path.join(tmpDir, filename);
  writeFileSync(file, source);
  const res = spawnSync(bin, ["-S", stage, file], { encoding: "utf8" });
  const output = `${res.stdout || ""}${res.stderr || ""}`.trim();
  return { ok: res.status === 0, output };
}

// ---------- 静态检查 a：同一程序内的同签名函数重名 ----------

const FN_RE = /^[ \t]*(?:highp\s+|mediump\s+|lowp\s+|const\s+)*([A-Za-z_]\w*)\s+([A-Za-z_]\w*)\s*\(([^;{}]*)\)\s*\{/gm;
const KEYWORD_EXCLUDE = new Set(["if", "for", "while", "switch", "else", "return", "do", "struct", "precision", "layout"]);
const QUALIFIER_SKIP = new Set(["const", "in", "out", "inout", "highp", "mediump", "lowp"]);
function paramType(p) {
  const tok = p.trim().split(/\s+/).filter(Boolean).find((t) => !QUALIFIER_SKIP.has(t));
  return tok || "";
}
function signatureOf(name, paramsStr) {
  const params = paramsStr.trim() === "" ? [] : paramsStr.split(",");
  return `${name}(${params.map(paramType).join(",")})`;
}
/** 在「已经拼好的一份程序源码」内找同签名函数重名（main 天然只有一个，不算） */
function findDuplicatesInProgram(text) {
  const bySignature = new Map();
  let m;
  FN_RE.lastIndex = 0;
  while ((m = FN_RE.exec(text))) {
    const [, type, name, params] = m;
    if (name === "main") continue;
    if (KEYWORD_EXCLUDE.has(type) || KEYWORD_EXCLUDE.has(name)) continue;
    const sig = signatureOf(name, params);
    const line = text.slice(0, m.index).split("\n").length;
    if (!bySignature.has(sig)) bySignature.set(sig, []);
    bySignature.get(sig).push(line);
  }
  return [...bySignature].filter(([, lines]) => lines.length > 1).map(([sig, lines]) => ({ sig, lines }));
}

// ---------- 静态检查 b：场景程序的 sampler 数 ----------

const GROUND_DETAIL_BLOCK_RE = /#ifdef\s+GROUND_DETAIL\b[\s\S]*?#endif\b/g;
/** stripGroundDetail=true 时先把 #ifdef GROUND_DETAIL ... #endif 整段挖掉再数（给默认变体用），
 * 「引用次数 > 1」（declaration 本身算一次）近似「链接后仍是 active uniform」，见文件头注释的局限说明 */
function samplerAudit(text, stripGroundDetail) {
  const scanned = stripGroundDetail ? text.replace(GROUND_DETAIL_BLOCK_RE, "") : text;
  const names = [...scanned.matchAll(/^\s*uniform\s+(sampler\w*)\s+(\w+)/gm)].map((m) => m[2]);
  const declared = [...new Set(names)];
  const active = declared.filter((n) => (scanned.match(new RegExp(`\\b${n}\\b`, "g")) || []).length > 1);
  return { declaredCount: declared.length, activeCount: active.length, active };
}

// ---------- 附带检查：scenarios.mjs 与 regression.playwright.js 的场景表是否同步 ----------

/** DX-03：regression.playwright.js 跑在 Playwright MCP 的沙箱里，没法直接 import scenarios.mjs
 * （原因见 scenarios.mjs 文件头注释），所以那边留了一份文本副本。这里做一次数据层面的一致性校验，
 * 防止两边悄悄跑偏——改动场景表后没同步会在这里报错，而不是等某个代理发现两边截图对不上。 */
function checkScenariosSync() {
  const regressionPath = path.join(SCRIPT_DIR, "regression.playwright.js");
  const text = readFileSync(regressionPath, "utf8");
  const m = text.match(/const SCENES = (\[[\s\S]*?\n  \]);/);
  if (!m) return { ok: false, reason: "在 regression.playwright.js 里没找到 `const SCENES = [...]`（正则要跟着改）" };
  let copy;
  try {
    // 场景表都是字面量（字符串 / 数字 / 数组 / 对象），用 Function 求值比手写 JSON 解析器省事，
    // 这里读的是仓库自己的文件，不是外部输入
    copy = new Function(`return ${m[1]}`)();
  } catch (err) {
    return { ok: false, reason: `regression.playwright.js 里的 SCENES 解析失败：${err.message}` };
  }
  const a = JSON.stringify(SCENES);
  const b = JSON.stringify(copy);
  if (a !== b) return { ok: false, reason: "scenarios.mjs 的 SCENES 和 regression.playwright.js 里的副本不一致，两处要一起改" };
  return { ok: true };
}

// ---------- 主流程 ----------

async function main() {
  const bin = glslangBin();
  const server = await createServer({ root: VOYAGE_ROOT, server: { middlewareMode: true }, appType: "custom", logLevel: "error" });
  let programs;
  try {
    programs = await collectPrograms(server);
  } finally {
    await server.close();
  }

  let exitCode = 0;
  console.log("== DX-02 离线 GLSL 检查 ==\n");
  console.log(`枚举到 ${programs.length} 个程序：${programs.map((p) => p.id).join(", ")}\n`);

  // -- 1. glslangValidator 语法校验 --
  console.log("-- 语法校验（glslangValidator） --");
  const unknownIncludes = new Set();
  const tmpDir = mkdtempSync(path.join(tmpdir(), "voyage-glsl-"));
  const vertSeen = new Map();
  try {
    for (const prog of programs) {
      const frag = FRAG_PREFIX + resolveIncludes(prog.fragmentShader, unknownIncludes);
      const fragRes = validate(bin, tmpDir, `${prog.id}.frag`, "frag", frag);
      if (fragRes.ok) console.log(`  [OK]   ${prog.id} (frag)`);
      else {
        exitCode = 1;
        console.log(`  [FAIL] ${prog.id} (frag)`);
        console.log(fragRes.output.split("\n").map((l) => `         ${l}`).join("\n"));
      }
      const vertKey = prog.vertexShader;
      if (!vertSeen.has(vertKey)) vertSeen.set(vertKey, { ids: [] });
      vertSeen.get(vertKey).ids.push(prog.id);
    }
    for (const [src, info] of vertSeen) {
      const vert = VERT_PREFIX + resolveIncludes(src, unknownIncludes);
      const res = validate(bin, tmpDir, `${info.ids[0]}.vert`, "vert", vert);
      const label = `顶点着色器（${info.ids.join(", ")} 共用）`;
      if (res.ok) console.log(`  [OK]   ${label}`);
      else {
        exitCode = 1;
        console.log(`  [FAIL] ${label}`);
        console.log(res.output.split("\n").map((l) => `         ${l}`).join("\n"));
      }
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
  if (unknownIncludes.size > 0) {
    exitCode = 1;
    console.log(`  [FAIL] 出现了没有登记桩的 THREE #include：${[...unknownIncludes].join(", ")}（去 INCLUDE_STUBS 里补一条）`);
  }

  // -- 2a. 同一程序内同签名函数重名 --
  console.log("\n-- 同一程序内的同签名函数重名 --");
  let anyDup = false;
  for (const prog of programs) {
    const dups = findDuplicatesInProgram(prog.fragmentShader);
    for (const d of dups) {
      anyDup = true;
      exitCode = 1;
      console.log(`  [FAIL] ${prog.id}: ${d.sig} 在同一程序里出现了 ${d.lines.length} 次（第 ${d.lines.join(", ")} 行）`);
    }
  }
  if (!anyDup) console.log("  [OK]   没有发现重名");

  // -- 2b. 场景程序 sampler 数 --
  console.log("\n-- 场景程序 sampler 数（ANGLE 上限 16） --");
  for (const prog of programs) {
    if (prog.id !== "scene-default" && prog.id !== "scene-ground-detail") continue;
    const strip = prog.id === "scene-default"; // 默认变体不含 GROUND_DETAIL 代码，把那部分挖掉再数
    const { declaredCount, activeCount, active } = samplerAudit(prog.fragmentShader, strip);
    const over = activeCount > 16;
    if (over) exitCode = 1;
    console.log(`  ${over ? "[FAIL]" : "[OK]  "} ${prog.id}: 引用中的 ${activeCount}/16（声明了 ${declaredCount} 个）`);
    if (over) console.log(`         ${active.join(", ")}`);
  }

  // -- 2c. scenarios.mjs 与 regression.playwright.js 的场景表是否同步 --
  console.log("\n-- 场景表同步（scenarios.mjs ↔ regression.playwright.js） --");
  const syncCheck = checkScenariosSync();
  if (syncCheck.ok) console.log("  [OK]   两边一致");
  else {
    exitCode = 1;
    console.log(`  [FAIL] ${syncCheck.reason}`);
  }

  console.log(`\n${exitCode === 0 ? "全部通过。" : "有检查项失败，见上面的 [FAIL]。"}`);
  process.exit(exitCode);
}

main().catch((err) => {
  console.error("lint-shaders 运行失败：", err);
  process.exit(1);
});
