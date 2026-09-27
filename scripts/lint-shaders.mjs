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
//    b. 场景程序的 sampler 数（ANGLE 上 MAX_TEXTURE_IMAGE_UNITS = 16，见 README 坑点）。先用一个最小的条件
//       编译展开器（resolveConditionals，支持 #ifdef/#ifndef/#if defined(...)/#else/#elif/嵌套）按「这个变体
//       真正会编译到的文本」保留代码，再做一次「从 main() 出发的可达性分析」把定义了但从 main() 到不了的
//       函数体整段剪掉（reachableFromMain / pruneUnreachable），最后数 sampler 引用次数。仍然是静态近似
//       （不做跨函数的数据流分析），但已经用私有 headless 对主分支 5181 的真实
//       `gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS)` 交叉验证过：scene-default / scene-ground-detail
//       静态数字和真实链接后的 active uniform 数完全一致（16/16），按致命检查处理，见 handoff/DX.md「已验证」
//       （2026-09-26 两轮审查返工：第一轮把 #ifdef…#endif 整段挖掉、连 #else 分支也删了；第二轮修好 #else 后
//       静态数字仍然比真实值多 1——多算的是 uMultiScatteringLut，只被 LUT 预计算程序调用，场景程序的
//       main() 从来到不了，靠可达性剪枝修正）。
//
// 用法（必须在 apps/voyage 目录树内跑，Node 的 ESM 解析从脚本所在目录向上找 node_modules 才能找到 vite）：
//   pnpm --filter voyage check:glsl
//   node scripts/lint-shaders.mjs --self-test   # 只测 samplerAudit / resolveConditionals 本身，不用 vite
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
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

export async function collectPrograms(server) {
  const programs = [];
  const add = (id, mat) => {
    if (!mat || typeof mat.fragmentShader !== "string") throw new Error(`${id}：拿到的不是一个 ShaderMaterial`);
    programs.push({ id, fragmentShader: mat.fragmentShader, vertexShader: mat.vertexShader });
  };

  // 场景（SC-5 起只剩舱内合成）+ 窗外 pass（默认变体）+ 窗外的 GROUND_DETAIL 变体（同一份 fragmentShader 源码，
  // GROUND_DETAIL 变体只是多一个 three 在编译期注入的 #define GROUND_DETAIL 1，这里手动补上，不走
  // GroundDetailVariant.prepare()——那个方法要真的调用 renderer.compileAsync，离线检查没有真实 GPU）
  {
    const m = await server.ssrLoadModule("/src/render/scene.ts");
    const ground = { albedo: null, water: null, height: null, levelUniform: [] };
    const mat = m.createSceneMaterial(deepMock(), {}, ground);
    add("scene-default", mat);
    // T25：舱内合成的经济舱变体（CabinClassVariant 在运行时加 #define CABIN_CLASS_ECONOMY 1，这里手动补上）
    programs.push({ id: "scene-economy", fragmentShader: "#define CABIN_CLASS_ECONOMY 1\n" + mat.fragmentShader, vertexShader: mat.vertexShader });
    const o = await server.ssrLoadModule("/src/render/outside-pass.ts");
    const outside = o.createOutsideMaterial(mat.uniforms);
    add("outside-default", outside);
    programs.push({
      id: "outside-ground-detail",
      fragmentShader: "#define GROUND_DETAIL 1\n" + outside.fragmentShader,
      vertexShader: outside.vertexShader,
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
    add("cloud-occupancy", clouds.occMat);
    add("cloud-shadow-map", clouds.shadowMat);
    add("cloud-probe", clouds.probeMat);
    // 奇观云间层（W00）：步进变体 + 奇观表面 pass；W00_PROBE=1 时连测试体一起校验
    programs.push({ id: "cloud-march-wonder", fragmentShader: "#define WONDER_LAYER 1\n#define CLOUD_CIRRUS 1\n" + clouds.marchWonderMat.fragmentShader, vertexShader: clouds.marchWonderMat.vertexShader });
    // 卷云变体（T12）
    programs.push({ id: "cloud-march-cirrus", fragmentShader: "#define CLOUD_CIRRUS 1\n" + clouds.marchCirrusMat.fragmentShader, vertexShader: clouds.marchCirrusMat.vertexShader });
    add("wonder-layer", clouds.wonderSurfMat);
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

export const INCLUDE_STUBS = {
  // THREE 的 #include <chunk> 由渲染器编译期注入，这里手写桩替换（原因见文件头注释）
  common: "",
  dithering_pars_fragment: "",
  tonemapping_fragment: "",
  colorspace_fragment: "gl_FragColor = linearToOutputTexel(gl_FragColor);",
  dithering_fragment: "#ifdef DITHERING\n  gl_FragColor.rgb = dithering(gl_FragColor.rgb);\n#endif",
};
const INCLUDE_RE = /^[ \t]*#include +<([\w.\/]+)>/gm;
export function resolveIncludes(src, unknown) {
  return src.replace(INCLUDE_RE, (m, name) => {
    if (!(name in INCLUDE_STUBS)) {
      unknown.add(name);
      return "";
    }
    return INCLUDE_STUBS[name];
  });
}

// layout(location = 0) 是必须的：cloud-march 之类的 MRT 程序自己额外声明了 layout(location = 1)
// out outDepth，GLSL ES 3.00 规定一旦有多个片元输出，全部输出都要显式给 location（否则 ANGLE 真实
// 编译会报 EXT_blend_func_extended 相关错误；glslangValidator 不检查这条，check:glsl 一直没发现，
// 是 shader-budget.mjs 翻译 cloud-march 时才暴露的，见 apps/voyage/handoff/SC-12.md）。
export const FRAG_PREFIX = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler3D;
precision highp sampler2DArray;
layout(location = 0) out highp vec4 pc_fragColor;
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
//
// 2026-09-26 审查返工：旧版用 /#ifdef GROUND_DETAIL\b[\s\S]*?#endif\b/ 把整段挖掉再数，
// 结果连 #else 分支也一起删了——真实预处理器在宏未定义时是「保留 #else、删掉 #ifdef 分支」，
// 不是「整段都删」。terrain-shading.glsl.ts 第 25–29 行 `#ifdef GROUND_DETAIL … #else … #endif`
// 里 uGroundAlbedo 在 #else 分支（默认变体真正会跑的那条路）里也有一次采样，旧版把这行也删了，
// 导致默认变体的「16/16 与 README 吻合」是巧合而不是证据。改成下面这个支持 #else / #elif /
// 嵌套 / #if defined(...) 的最小条件编译展开，按「这个变体真正会编译到的文本」来数。

/** 极简条件编译展开：按 defines（Set<宏名>）保留 #ifdef/#ifndef/#if defined(...)/#else/#elif/#endif
 * 里真正会被编译进这个变体的那部分文本，指令行本身丢弃。支持任意深度嵌套。
 * 只服务于「按文本数 sampler / 找重名」这类静态检查，不是真正的 GLSL 预处理器（不做宏替换、
 * 不展开 #define 常量、不算 #if 的算术表达式）——glslangValidator 校验用的是原始文本 + 自己的真预处理器，
 * 不经过这里。 */
function resolveConditionals(text, defines) {
  const lines = text.split("\n");
  const out = [];
  const stack = []; // { active: 这一层当前分支是否被编译, taken: 这条 #if/#elif 链是否已经有分支命中过 }
  const allActive = () => stack.every((s) => s.active);
  const evalCond = (expr) => {
    const m = expr.trim().match(/^!?\s*defined\s*\(?\s*([A-Za-z_]\w*)\s*\)?$/);
    const negate = expr.trim().startsWith("!");
    const name = m ? m[1] : expr.trim().replace(/^!/, "").trim();
    const v = defines.has(name);
    return negate ? !v : v;
  };
  for (const line of lines) {
    const t = line.trim();
    let m;
    if ((m = t.match(/^#ifdef\s+([A-Za-z_]\w*)/))) {
      const cond = defines.has(m[1]);
      stack.push({ active: cond, taken: cond });
    } else if ((m = t.match(/^#ifndef\s+([A-Za-z_]\w*)/))) {
      const cond = !defines.has(m[1]);
      stack.push({ active: cond, taken: cond });
    } else if ((m = t.match(/^#if\s+(.+)/))) {
      const cond = evalCond(m[1]);
      stack.push({ active: cond, taken: cond });
    } else if ((m = t.match(/^#elif\s+(.+)/))) {
      const top = stack[stack.length - 1];
      if (top) {
        if (top.taken) top.active = false;
        else {
          const cond = evalCond(m[1]);
          top.active = cond;
          top.taken = cond;
        }
      }
    } else if (t === "#else") {
      const top = stack[stack.length - 1];
      if (top) {
        top.active = !top.taken;
        top.taken = true;
      }
    } else if (t === "#endif") {
      stack.pop();
    } else if (allActive()) {
      out.push(line);
    }
  }
  return out.join("\n");
}

// 2026-09-26 第二次审查返工：修好 #else 之后，scene-default 和 scene-ground-detail 静态都数出 17，
// 但私有 headless 对主分支 5181 的真实 gl.getProgramParameter(ACTIVE_UNIFORMS) 读出来两个变体都是 16
// （见 handoff/DX.md「已验证」）。根因：ATMOSPHERE_COMMON 里的 multiScattering()（读 uMultiScatteringLut）
// 只被 luts.ts 的 IRRADIANCE_FRAG / SKY_VIEW_FRAG / AERIAL_FRAG（LUT 预计算，另外的程序）调用，
// 从场景程序的 main() 顺着调用链走下去根本到不了这个函数——真实编译器的死代码消除会把它连同它读的
// sampler 一起砍掉，纯文本「这个名字在哪都出现过」的计数看不出「这段代码是否真的从 main() 可达」。
// 所以在数 sampler 之前先做一次「从 main() 出发的可达性分析」：不可达的函数体整段当作不存在。

/** 提取顶层函数定义：{ name, bodyStart, bodyEnd }，bodyStart/bodyEnd 是 text 里函数体（花括号内部，
 * 不含花括号本身）的字符下标，用花括号配对找函数体的真正结尾（FN_RE 只能定位到函数体开始的那个 `{`）。 */
function extractFunctions(text) {
  const fns = [];
  const re = new RegExp(FN_RE.source, "gm");
  let m;
  while ((m = re.exec(text))) {
    const [, type, name] = m;
    if (KEYWORD_EXCLUDE.has(type) || KEYWORD_EXCLUDE.has(name)) continue;
    const openBrace = m.index + m[0].length - 1; // m[0] 以 '{' 结尾
    let depth = 1;
    let i = openBrace + 1;
    for (; i < text.length && depth > 0; i++) {
      if (text[i] === "{") depth++;
      else if (text[i] === "}") depth--;
    }
    fns.push({ name, bodyStart: openBrace + 1, bodyEnd: i - 1 });
  }
  return fns;
}

/** 从 main 出发，按「函数体里出现了另一个已知函数名 + 左括号」当作调用边，做一次可达性 BFS。
 * 同名函数（本该被「同签名函数重名」检查抓住）按「名字可达就整批都算可达」处理，偏保守（宁可多算不漏算）。 */
function reachableFromMain(text, fns) {
  const byName = new Map();
  for (const fn of fns) {
    if (!byName.has(fn.name)) byName.set(fn.name, []);
    byName.get(fn.name).push(fn);
  }
  const allNames = [...byName.keys()];
  const reachable = new Set();
  const queue = ["main"];
  while (queue.length > 0) {
    const cur = queue.pop();
    if (reachable.has(cur) || !byName.has(cur)) continue;
    reachable.add(cur);
    for (const fn of byName.get(cur)) {
      const body = text.slice(fn.bodyStart, fn.bodyEnd);
      for (const other of allNames) {
        if (reachable.has(other)) continue;
        if (new RegExp(`\\b${other}\\b\\s*\\(`).test(body)) queue.push(other);
      }
    }
  }
  return { reachable, byName };
}

/** 把「定义了但从 main() 到不了」的函数体整段挖掉（只留函数体，签名行和花括号留着，反正只影响
 * 函数体内部的 sampler 引用计数），返回剪掉死代码之后的文本。 */
function pruneUnreachable(text, fns, reachable) {
  const dead = fns.filter((f) => !reachable.has(f.name)).sort((a, b) => b.bodyStart - a.bodyStart);
  let out = text;
  for (const f of dead) out = out.slice(0, f.bodyStart) + out.slice(f.bodyEnd);
  return out;
}

/** defines 决定这是哪个变体（默认变体传空 Set，GROUND_DETAIL 变体传 Set(["GROUND_DETAIL"])）。
 * 先按变体展开条件编译，再把从 main() 到不了的函数体挖掉，最后数「引用次数 > 1」（declaration 本身
 * 算一次）近似「链接后仍是 active uniform」。这样比单纯数文本引用更接近真实的死代码消除，
 * 但仍然是静态近似——不做跨函数的数据流分析（例如一个可达函数把结果赋给一个从没被读过的变量，
 * 这种情况这里看不出来）。真正精确的数字要用 dev-browser.mjs 起真实 WebGL2 上下文读
 * gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS)（已经对主分支 5181 验证过，见 handoff/DX.md）。 */
function samplerAudit(text, defines) {
  const scanned = resolveConditionals(text, defines);
  const fns = extractFunctions(scanned);
  const { reachable } = reachableFromMain(scanned, fns);
  const pruned = pruneUnreachable(scanned, fns, reachable);
  const names = [...pruned.matchAll(/^\s*uniform\s+(sampler\w*)\s+(\w+)/gm)].map((m) => m[2]);
  const declared = [...new Set(names)];
  const active = declared.filter((n) => (pruned.match(new RegExp(`\\b${n}\\b`, "g")) || []).length > 1);
  return { declaredCount: declared.length, activeCount: active.length, active };
}

// ---------- DX-09：README「硬约束速查表」的 sampler 表格，机器生成、机器比对 ----------
//
// README 手写过一次 sampler 数字，几波开发下来就和实测脱节（DX_REPORT_wave6 §1 第 5 条：README 写
// 窗外 16/16、scene-default 3/16，实测早已是窗外 14/16、scene-default / scene-economy 5/16）。
// 这里把「拼表格」和「数 sampler」用同一份数据、同一段代码做（emit 与 check 共用 computeSamplerRows /
// renderSamplerTable），杜绝「表格自己一份逻辑、检查另一份逻辑」两边悄悄分叉。
// 用法：`node scripts/lint-shaders.mjs --emit-table` 打印表格，手工贴进 README 硬约束速查表里
// `<!-- DX-09:sampler-table:begin -->` … `<!-- DX-09:sampler-table:end -->` 之间；
// 平时 `check:glsl` 会自动比对 README 里的这段和实测是否一致，不一致就 FAIL 并提示同一条命令。

/** ANGLE 上 MAX_TEXTURE_IMAGE_UNITS，场景 / 窗外程序的 sampler 硬上限（坑点「窗外着色器的 sampler 已满」）。 */
export const SAMPLER_LIMIT = 16;

/** 需要进速查表、也需要致命检查的程序 id，顺序即表格行序。 */
const SAMPLER_TABLE_PROGRAMS = ["scene-default", "scene-economy", "outside-default", "outside-ground-detail"];

export const SAMPLER_TABLE_BEGIN = "<!-- DX-09:sampler-table:begin -->";
export const SAMPLER_TABLE_END = "<!-- DX-09:sampler-table:end -->";

function samplerDefinesFor(id) {
  return id === "outside-ground-detail" ? new Set(["GROUND_DETAIL"]) : id === "scene-economy" ? new Set(["CABIN_CLASS_ECONOMY"]) : new Set();
}

/** 对 collectPrograms() 的结果，按 SAMPLER_TABLE_PROGRAMS 逐个跑 samplerAudit，返回表格需要的行
 * （含 over-limit 判断要用的 active 名单）。程序缺失就直接抛错——说明 collectPrograms 的枚举变了，
 * 表格和实测哪个都不该悄悄跳过一行。 */
export function computeSamplerRows(programs) {
  const byId = new Map(programs.map((p) => [p.id, p]));
  return SAMPLER_TABLE_PROGRAMS.map((id) => {
    const prog = byId.get(id);
    if (!prog) throw new Error(`sampler 表缺少程序 ${id}（collectPrograms 的枚举变了？README 表格和这里要一起改)`);
    const { declaredCount, activeCount, active } = samplerAudit(prog.fragmentShader, samplerDefinesFor(id));
    return { id, declaredCount, activeCount, active };
  });
}

/** 渲染成可以直接整段贴进 README 的 Markdown（含首尾标记行）。emit 和 check 走同一份渲染逻辑，
 * 避免「生成的格式」和「比对时期望的格式」两处手写、悄悄不一致。 */
export function renderSamplerTable(rows) {
  const lines = [
    SAMPLER_TABLE_BEGIN,
    "| 程序 | sampler 上限 | 当前用量（引用中 / 声明） |",
    "| --- | --- | --- |",
    ...rows.map((r) => `| \`${r.id}\` | ${SAMPLER_LIMIT} | ${r.activeCount} / ${r.declaredCount} |`),
    SAMPLER_TABLE_END,
  ];
  return lines.join("\n");
}

/** 归一化：统一换行符、去掉每行行尾空白，避免 CRLF / 编辑器自动加的行尾空格造成误报。 */
function normalizeTableText(s) {
  return s
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((l) => l.trimEnd())
    .join("\n")
    .trim();
}

function extractReadmeTable(readmeText) {
  const bi = readmeText.indexOf(SAMPLER_TABLE_BEGIN);
  const ei = readmeText.indexOf(SAMPLER_TABLE_END);
  if (bi === -1 || ei === -1 || ei < bi) return null;
  return readmeText.slice(bi, ei + SAMPLER_TABLE_END.length);
}

/** 比对 README.md 里的 sampler 表格和 rows 算出来的实测是否一致。 */
export function checkReadmeSamplerTable(rows, readmeText) {
  const expected = renderSamplerTable(rows);
  const actual = extractReadmeTable(readmeText);
  if (actual === null) {
    return {
      ok: false,
      reason: `README.md 里没找到 sampler 速查表标记（${SAMPLER_TABLE_BEGIN} … ${SAMPLER_TABLE_END}），先手工放好这对标记，再跑 node scripts/lint-shaders.mjs --emit-table 生成内容`,
    };
  }
  if (normalizeTableText(actual) !== normalizeTableText(expected)) {
    return {
      ok: false,
      reason:
        `README.md 的 sampler 表格和实测不一致，跑 node scripts/lint-shaders.mjs --emit-table，把输出整段替换掉 README 里 ` +
        `${SAMPLER_TABLE_BEGIN} … ${SAMPLER_TABLE_END} 之间的内容\n---- 期望 ----\n${expected}\n---- README 里实际的 ----\n${actual}`,
    };
  }
  return { ok: true };
}

// ---------- samplerAudit / resolveConditionals 自检（node scripts/lint-shaders.mjs --self-test） ----------

function runSelfTest() {
  const cases = [];
  const check = (name, fn) => cases.push({ name, fn });

  check("#ifdef/#else：未定义时走 #else 分支", () => {
    const src = ["uniform sampler2D uA;", "#ifdef X", "foo(uA);", "#else", "bar(uA);", "#endif"].join("\n");
    const r = samplerAudit(src, new Set());
    if (r.activeCount !== 1) throw new Error(`期望 activeCount=1（#else 分支里的 uA 应该算 active），实际 ${r.activeCount}`);
  });

  check("#ifdef/#else：定义时走 #ifdef 分支，#else 分支不算数", () => {
    const src = ["uniform sampler2D uA;", "uniform sampler2D uB;", "#ifdef X", "foo(uA);", "#else", "bar(uB);", "#endif"].join("\n");
    const r = samplerAudit(src, new Set(["X"]));
    if (!r.active.includes("uA") || r.active.includes("uB")) throw new Error(`期望只有 uA active，实际 ${JSON.stringify(r.active)}`);
  });

  check("只在 #ifdef 分支里用、没有 #else：未定义时不算 active", () => {
    const src = ["uniform sampler2D uA;", "#ifdef X", "foo(uA);", "#endif"].join("\n");
    const r = samplerAudit(src, new Set());
    if (r.activeCount !== 0) throw new Error(`期望 activeCount=0，实际 ${r.activeCount}`);
  });

  check("同一个 uniform 在 #ifdef 和 #else 两个分支都用（terrain-shading.glsl.ts 的真实模式）", () => {
    const src = ["uniform sampler2D uGroundAlbedo;", "#ifdef GROUND_DETAIL", "a(uGroundAlbedo);", "#else", "b(uGroundAlbedo);", "#endif"].join("\n");
    const r0 = samplerAudit(src, new Set());
    const r1 = samplerAudit(src, new Set(["GROUND_DETAIL"]));
    if (r0.activeCount !== 1 || r1.activeCount !== 1) throw new Error(`两个变体都应该算 uGroundAlbedo active，实际 ${r0.activeCount} / ${r1.activeCount}`);
  });

  check("嵌套 #ifdef：两层都要满足", () => {
    const src = ["uniform sampler2D uB;", "#ifdef X", "#ifdef Y", "use(uB);", "#endif", "#endif"].join("\n");
    if (samplerAudit(src, new Set()).activeCount !== 0) throw new Error("defines={} 时应该是 0");
    if (samplerAudit(src, new Set(["X"])).activeCount !== 0) throw new Error("defines={X} 时应该还是 0（Y 没定义）");
    if (samplerAudit(src, new Set(["X", "Y"])).activeCount !== 1) throw new Error("defines={X,Y} 时应该是 1");
  });

  check("#if defined(X) 语法（不只是 #ifdef）", () => {
    const src = ["uniform sampler2D uA;", "#if defined(X)", "use(uA);", "#endif"].join("\n");
    if (samplerAudit(src, new Set()).activeCount !== 0) throw new Error("未定义时应该是 0");
    if (samplerAudit(src, new Set(["X"])).activeCount !== 1) throw new Error("定义了应该是 1");
  });

  check("声明了但完全没被引用：不算 active", () => {
    const src = ["uniform sampler2D uUnused;"].join("\n");
    const r = samplerAudit(src, new Set());
    if (r.declaredCount !== 1 || r.activeCount !== 0) throw new Error(`期望 declared=1 active=0，实际 ${JSON.stringify(r)}`);
  });

  check("sampler 只在一个从 main() 到不了的函数里用：不算 active（复现 uMultiScatteringLut 的真实情况——" +
    "multiScattering() 只被 LUT 预计算程序调用，场景程序的 main() 从来不会走到它）", () => {
    const src = [
      "uniform sampler2D uLive;",
      "uniform sampler2D uDead;",
      "float helperUsed(float x) { return sampleStub(uLive, x); }",
      "float helperUnused(float x) { return sampleStub(uDead, x); }", // 定义了但从没被任何可达函数调用过
      "void main() { helperUsed(1.0); }",
    ].join("\n");
    const r = samplerAudit(src, new Set());
    if (!r.active.includes("uLive") || r.active.includes("uDead")) {
      throw new Error(`期望只有 uLive active（uDead 所在的 helperUnused 从 main() 到不了），实际 ${JSON.stringify(r.active)}`);
    }
  });

  check("可达性支持链式调用（main → a → b）", () => {
    const src = [
      "uniform sampler2D uChained;",
      "float b(float x) { return sampleStub(uChained, x); }",
      "float a(float x) { return b(x); }",
      "void main() { a(1.0); }",
    ].join("\n");
    const r = samplerAudit(src, new Set());
    if (!r.active.includes("uChained")) throw new Error(`期望链式可达，uChained 应该 active，实际 ${JSON.stringify(r.active)}`);
  });

  let fail = 0;
  console.log("== samplerAudit / resolveConditionals 自检 ==");
  for (const { name, fn } of cases) {
    try {
      fn();
      console.log(`  [OK]   ${name}`);
    } catch (err) {
      fail++;
      console.log(`  [FAIL] ${name}：${err.message}`);
    }
  }
  console.log(`\n${fail === 0 ? `全部 ${cases.length} 项通过。` : `${fail}/${cases.length} 项失败。`}`);
  return fail === 0;
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

// ---------- 附带检查：src/ 下有没有 CRLF 行尾 ----------
//
// T35 坑点（README「坑点」倒数第一条）：Windows 上 Python 用 `open(p, 'w')` 文本模式写回源文件，
// `\n` 会被自动写成 `\r\n`，git 提交时才报 "CRLF will be replaced"——发现得晚，且要等到 git add 才暴露。
// `.gitattributes` 把仓库文本统一成 LF，这里提前到 check:glsl 里做一次快速扫描（读文件找有没有裸的
// \r 字节），提交前就能抓住，不用等 git 提醒。

/** 递归列出 dir 下所有文件（全路径） */
function listFilesRecursive(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFilesRecursive(p));
    else out.push(p);
  }
  return out;
}

/** src/ 下出现 \r 字节（CRLF 或裸 CR）的文件列表，仓库相对路径、正斜杠 */
function findCrlfFiles() {
  const srcRoot = path.join(VOYAGE_ROOT, "src");
  const offenders = [];
  for (const file of listFilesRecursive(srcRoot)) {
    const buf = readFileSync(file);
    if (buf.includes(0x0d)) offenders.push(path.relative(VOYAGE_ROOT, file).replace(/\\/g, "/"));
  }
  return offenders;
}

// ---------- 主流程 ----------

async function main() {
  if (process.argv.includes("--self-test")) {
    // 只测 samplerAudit / resolveConditionals 本身，不需要 vite / glslangValidator，几十毫秒跑完
    process.exit(runSelfTest() ? 0 : 1);
  }

  if (process.argv.includes("--emit-table")) {
    // DX-09：只打印 README 硬约束速查表要贴的 sampler 表格，不跑语法校验 / 重名检查，用来在改了着色器
    // 结构之后重新生成表格内容（README 那份和这里数出来的必须逐字一致，check:glsl 的 2d 步会比对）。
    const server = await createServer({ root: VOYAGE_ROOT, server: { middlewareMode: true }, appType: "custom", logLevel: "error" });
    let programs;
    try {
      programs = await collectPrograms(server);
    } finally {
      await server.close();
    }
    console.log(renderSamplerTable(computeSamplerRows(programs)));
    process.exit(0);
  }

  let exitCode = 0;
  console.log("== DX-02 离线 GLSL 检查 ==\n");

  // -- 0. src/ 下 CRLF 行尾（不需要 vite，先做这个最快） --
  console.log("-- src/ 下 CRLF 行尾 --");
  const crlfFiles = findCrlfFiles();
  if (crlfFiles.length === 0) console.log("  [OK]   没有发现 CRLF");
  else {
    exitCode = 1;
    console.log(`  [FAIL] ${crlfFiles.length} 个文件有 CRLF 行尾（仓库统一 LF，见 .gitattributes）：`);
    for (const f of crlfFiles) console.log(`         ${f}`);
  }

  const bin = glslangBin();
  const server = await createServer({ root: VOYAGE_ROOT, server: { middlewareMode: true }, appType: "custom", logLevel: "error" });
  let programs;
  try {
    programs = await collectPrograms(server);
  } finally {
    await server.close();
  }

  console.log(`\n枚举到 ${programs.length} 个程序：${programs.map((p) => p.id).join(", ")}\n`);

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
  // 2026-09-26 审查返工：修好 #else 分支 + 加上「从 main() 可达性剪枝」之后，静态数字和私有 headless
  // 对主分支 5181 实测的 gl.getProgramParameter(ACTIVE_UNIFORMS) 完全对上（scene-default /
  // scene-ground-detail 都是 16/16，见 handoff/DX.md「已验证」）。结论已明确，恢复为致命检查。
  // 仍然是静态近似（没有做跨函数数据流分析），只是现在经过了真实 GPU 交叉验证；以后这里报 FAIL
  // 时先怀疑真的超限了，但如果怀疑是静态法的盲区，用 dev-browser.mjs 起 WebGL2 读
  // gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS) 复核一次再下结论。
  console.log(`\n-- 场景 / 窗外程序 sampler 数（ANGLE 上限 ${SAMPLER_LIMIT}，已用真实 GPU 交叉验证，见 handoff/DX.md） --`);
  const samplerRows = computeSamplerRows(programs);
  for (const r of samplerRows) {
    const over = r.activeCount > SAMPLER_LIMIT;
    if (over) exitCode = 1;
    console.log(`  ${over ? "[FAIL]" : "[OK]  "} ${r.id}: 引用中的 ${r.activeCount}/${SAMPLER_LIMIT}（声明了 ${r.declaredCount} 个）`);
    if (over) console.log(`         ${r.active.join(", ")}（怀疑是静态法盲区的话，用 dev-browser.mjs 读真实 ACTIVE_UNIFORMS 复核）`);
  }

  // -- 2c. scenarios.mjs 与 regression.playwright.js 的场景表是否同步 --
  console.log("\n-- 场景表同步（scenarios.mjs ↔ regression.playwright.js） --");
  const syncCheck = checkScenariosSync();
  if (syncCheck.ok) console.log("  [OK]   两边一致");
  else {
    exitCode = 1;
    console.log(`  [FAIL] ${syncCheck.reason}`);
  }

  // -- 2d. README「硬约束速查表」的 sampler 表格是否与实测一致（DX-09） --
  console.log("\n-- README 硬约束速查表：sampler 表格与实测比对 --");
  const readmeText = readFileSync(path.join(VOYAGE_ROOT, "README.md"), "utf8");
  const tableCheck = checkReadmeSamplerTable(samplerRows, readmeText);
  if (tableCheck.ok) console.log("  [OK]   README 表格与实测一致");
  else {
    exitCode = 1;
    console.log(`  [FAIL] ${tableCheck.reason}`);
  }

  console.log(`\n${exitCode === 0 ? "全部通过。" : "有检查项失败，见上面的 [FAIL]。"}`);
  process.exit(exitCode);
}

// 只在直接执行本文件（`node scripts/lint-shaders.mjs`）时跑 main()；被 shader-budget.mjs 之类的脚本
// `import { collectPrograms } from "./lint-shaders.mjs"` 时不能自动触发（否则会重复起一次 vite server、
// 多跑一遍语法校验，还会在检查完后 process.exit() 把调用方一起杀掉）。
const isMain = path.resolve(process.argv[1] || "") === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    console.error("lint-shaders 运行失败：", err);
    process.exit(1);
  });
}
