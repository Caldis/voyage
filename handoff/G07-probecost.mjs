// G07：临时 WebGL2 上下文探测 GPU 的代价——第一次开上下文（要初始化 ANGLE / D3D11 设备）和紧接着第二次开的耗时对比。
// 结论用来判断「探测上下文」是新增了启动时间，还是只是把主渲染器本来要付的设备初始化提前了。
// 用法（apps/voyage 下）：node handoff/G07-probecost.mjs <端口>
import { chromium } from "playwright-core";
import { launchBrowser } from "../scripts/lib/chrome.mjs";

const [port] = process.argv.slice(2);
const browser = await launchBrowser(chromium, {});
try {
  const out = [];
  for (let k = 0; k < 3; k++) {
    const page = await (await browser.newContext()).newPage();
    await page.goto(`http://127.0.0.1:${port}/g07-none.html`, { waitUntil: "commit" }).catch(() => {});
    out.push(
      await page.evaluate(() => {
        const t = [];
        for (let i = 0; i < 3; i++) {
          const t0 = performance.now();
          const gl = document.createElement("canvas").getContext("webgl2");
          gl.getParameter(gl.MAX_TEXTURE_SIZE);
          t.push(+(performance.now() - t0).toFixed(1));
          if (i < 2) gl.getExtension("WEBGL_lose_context")?.loseContext();
        }
        return t;
      }),
    );
    await page.close();
  }
  console.log("每页依次开 3 个上下文的耗时（ms）：", JSON.stringify(out));
} finally {
  await browser.close();
}
