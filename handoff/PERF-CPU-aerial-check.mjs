// PERF-CPU：空气透视 LUT 改成 MRT 一遍画出后，与「分两遍、uOutputTransmittance 选输出」的旧做法逐位对照。
// 同一页面里：用当前材质的着色器文本还原旧着色器（输出声明 / 两行输出换回旧写法），画进两张旧式单附件 3D 目标，
// 再让 atmosphere.updateAerialPerspective 用同样的输入画一遍新目标，四张图逐 texel 读回（32 位浮点）比较。
// 用法：node handoff/PERF-CPU-aerial-check.mjs <端口>
import { chromium } from "playwright-core";
import { findChromeExecutable } from "../scripts/lib/chrome.mjs";

const port = Number(process.argv[2] || 5249);
const browser = await chromium.launch({ executablePath: findChromeExecutable(), headless: true, args: ["--use-angle=d3d11"] });
try {
  const page = await (await browser.newContext({ viewport: { width: 800, height: 600 } })).newPage();
  await page.goto(`http://127.0.0.1:${port}/?dev=${Date.now()}`, { waitUntil: "commit", timeout: 180000 });
  await page.waitForFunction(() => window.__voyageStartup, null, { timeout: 300000, polling: 500 });
  const out = await page.evaluate(async () => {
    const v = window.__voyage;
    v.freeze(true);
    const atm = v.atmosphere;
    const pass = atm.pass;
    const renderer = pass.renderer;
    const THREE_RT = atm.aerial.constructor; // WebGL3DRenderTarget
    const gl = renderer.getContext();
    const newMat = atm.aerialMaterial;
    const src = newMat.fragmentShader;
    const oldSrc = src
      .replace("layout(location = 1) out highp vec4 aerialTransmittanceOut;", "uniform bool uOutputTransmittance;")
      .replace("gl_FragColor = vec4(L, 1.0);\n  aerialTransmittanceOut = vec4(T, 1.0);", "gl_FragColor = vec4(uOutputTransmittance ? T : L, 1.0);");
    if (oldSrc === src || !oldSrc.includes("uOutputTransmittance ? T : L")) return { error: "还原旧着色器失败（文本对不上）" };
    const oldMat = newMat.clone();
    oldMat.fragmentShader = oldSrc;
    oldMat.uniforms = { ...newMat.uniforms, uOutputTransmittance: { value: false } };
    const [w, h, d] = [atm.aerial.width, atm.aerial.height, atm.aerial.depth];
    const t0 = atm.aerial.textures[0];
    const mk = () => {
      const rt = new THREE_RT(w, h, d, { type: t0.type, format: t0.format, minFilter: t0.minFilter, magFilter: t0.magFilter, depthBuffer: false });
      return rt;
    };
    const oldIn = mk(), oldT = mk();
    const camR = 6360 + 10.7, sunCos = 0.3712345;
    // 新做法
    atm.updateAerialPerspective(camR, sunCos);
    // 旧做法（同样的 uniform 值：updateAerialPerspective 刚写进共享的 uniform 对象里）
    oldMat.uniforms.uCamR = newMat.uniforms.uCamR;
    oldMat.uniforms.uSunDirLocal = newMat.uniforms.uSunDirLocal;
    oldMat.uniforms.uLayer = { value: 0 };
    for (const [rt, isT] of [[oldIn, false], [oldT, true]]) {
      oldMat.uniforms.uOutputTransmittance.value = isT;
      for (let layer = 0; layer < d; layer++) {
        oldMat.uniforms.uLayer.value = layer;
        pass.render(oldMat, rt, layer);
      }
    }
    const props = renderer.properties;
    const fb = gl.createFramebuffer();
    const read = (tex) => {
      const wt = props.get(tex).__webglTexture;
      const all = new Float32Array(w * h * d * 4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      for (let l = 0; l < d; l++) {
        gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, wt, 0, l);
        gl.readPixels(0, 0, w, h, gl.RGBA, gl.FLOAT, all.subarray(l * w * h * 4, (l + 1) * w * h * 4));
      }
      return all;
    };
    const cmp = (a, b) => {
      let diff = 0, maxAbs = 0, maxRel = 0, nonzero = 0;
      for (let i = 0; i < a.length; i++) {
        if (a[i] !== 0) nonzero++;
        if (a[i] !== b[i]) {
          diff++;
          maxAbs = Math.max(maxAbs, Math.abs(a[i] - b[i]));
          maxRel = Math.max(maxRel, Math.abs(a[i] - b[i]) / Math.max(1e-30, Math.abs(b[i])));
        }
      }
      return { n: a.length, nonzero, diff, maxAbs, maxRel };
    };
    const r = {
      float32: atm.float32,
      inscatter: cmp(read(atm.aerial.textures[0]), read(oldIn.texture)),
      transmittance: cmp(read(atm.aerial.textures[1]), read(oldT.texture)),
    };
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(fb);
    renderer.resetState();
    oldIn.dispose();
    oldT.dispose();
    v.freeze(false);
    return r;
  });
  console.log(JSON.stringify(out, null, 1));
} finally {
  await browser.close();
}
