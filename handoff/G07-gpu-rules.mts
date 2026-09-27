// G07：GPU 渲染器字符串 → 地面精度档的规则自检（离线）。
// 用法（apps/voyage 下）：node --import ./scripts/lib/ts-resolve.mjs --experimental-transform-types --no-warnings handoff/G07-gpu-rules.mts
import { isHighEndGpu } from "../src/quality";

const cases: [string, boolean][] = [
  ["ANGLE (NVIDIA, NVIDIA GeForce RTX 5090 (0x00002B85) Direct3D11 vs_5_0 ps_5_0, D3D11)", true],
  ["ANGLE (NVIDIA, NVIDIA GeForce RTX 3050 Laptop GPU Direct3D11 vs_5_0 ps_5_0, D3D11)", true],
  ["ANGLE (NVIDIA, NVIDIA GeForce GTX 1660 SUPER Direct3D11 vs_5_0 ps_5_0, D3D11)", true],
  ["ANGLE (NVIDIA, NVIDIA GeForce GTX 1070 Direct3D11 vs_5_0 ps_5_0, D3D11)", true],
  ["ANGLE (NVIDIA, NVIDIA GeForce GTX 1050 Ti Direct3D11 vs_5_0 ps_5_0, D3D11)", false],
  ["ANGLE (NVIDIA, NVIDIA GeForce MX450 Direct3D11 vs_5_0 ps_5_0, D3D11)", false],
  ["ANGLE (NVIDIA, NVIDIA GeForce GT 1030 Direct3D11 vs_5_0 ps_5_0, D3D11)", false],
  ["ANGLE (NVIDIA, NVIDIA Quadro P400 Direct3D11 vs_5_0 ps_5_0, D3D11)", false],
  ["ANGLE (NVIDIA, NVIDIA RTX A4000 Direct3D11 vs_5_0 ps_5_0, D3D11)", true],
  ["ANGLE (AMD, AMD Radeon RX 7900 XTX Direct3D11 vs_5_0 ps_5_0, D3D11)", true],
  ["ANGLE (AMD, AMD Radeon(TM) Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)", false],
  ["ANGLE (AMD, Radeon RX Vega 8 Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)", false],
  ["ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)", false],
  ["ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)", false],
  ["ANGLE (Intel, Intel(R) Arc(TM) A770 Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)", true],
  ["ANGLE (Intel, Intel(R) Arc(TM) Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)", false],
  ["ANGLE (Apple, ANGLE Metal Renderer: Apple M1, Unspecified Version)", false],
  ["ANGLE (Apple, ANGLE Metal Renderer: Apple M3 Max, Unspecified Version)", true],
  ["Apple GPU", false],
  ["ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)", false],
  ["Mali-G78", false],
  // G07b：G07 审查 L2 指出的偏宽 / 偏严型号（审查脚本 g07rev-rules.mts 的补充字符串）
  ["ANGLE (NVIDIA, NVIDIA GeForce GTX 980 Ti Direct3D11 vs_5_0 ps_5_0, D3D11)", true], // 原先偏严
  ["NVIDIA GeForce GTX 980, or similar", true], // Firefox 的模糊型号
  ["ANGLE (NVIDIA, NVIDIA GeForce GTX 970 Direct3D11 vs_5_0 ps_5_0, D3D11)", true],
  ["ANGLE (NVIDIA, NVIDIA GeForce GTX 970M Direct3D11 vs_5_0 ps_5_0, D3D11)", false], // G07b 审查 L2
  ["ANGLE (NVIDIA, NVIDIA GeForce GTX 980 Ti Direct3D11 vs_5_0 ps_5_0, D3D11)", true],
  ["ANGLE (AMD, AMD Radeon Pro WX 3100 Direct3D11 vs_5_0 ps_5_0, D3D11)", false], // G07b 审查 L2
  ["ANGLE (AMD, AMD Radeon Pro WX 7100 Direct3D11 vs_5_0 ps_5_0, D3D11)", true],
  ["ANGLE (NVIDIA, NVIDIA GeForce GTX 960 Direct3D11 vs_5_0 ps_5_0, D3D11)", false],
  ["ANGLE (NVIDIA, NVIDIA GeForce GTX 1080 Ti Direct3D11 vs_5_0 ps_5_0, D3D11)", true],
  ["ANGLE (NVIDIA, NVIDIA Quadro P5000 Direct3D11 vs_5_0 ps_5_0, D3D11)", true], // 原先偏严
  ["ANGLE (NVIDIA, NVIDIA Quadro P4000 Direct3D11 vs_5_0 ps_5_0, D3D11)", true],
  ["ANGLE (NVIDIA, NVIDIA Quadro P2000 Direct3D11 vs_5_0 ps_5_0, D3D11)", false],
  ["ANGLE (NVIDIA, NVIDIA Quadro P1000 Direct3D11 vs_5_0 ps_5_0, D3D11)", false],
  ["ANGLE (NVIDIA, NVIDIA Quadro M4000 Direct3D11 vs_5_0 ps_5_0, D3D11)", false],
  ["ANGLE (NVIDIA, NVIDIA Quadro T1000 Direct3D11 vs_5_0 ps_5_0, D3D11)", true], // 与 GTX 1650 同档，保留 2048
  ["ANGLE (NVIDIA, NVIDIA T600 Direct3D11 vs_5_0 ps_5_0, D3D11)", false],
  ["ANGLE (NVIDIA, NVIDIA GeForce RTX 2050 Direct3D11 vs_5_0 ps_5_0, D3D11)", true],
  ["ANGLE (NVIDIA Corporation, NVIDIA GeForce RTX 4070/PCIe/SSE2, OpenGL 4.5.0)", true],
  ["ANGLE (AMD, AMD Radeon RX 550 Direct3D11 vs_5_0 ps_5_0, D3D11)", false], // 原先偏宽
  ["ANGLE (AMD, AMD Radeon RX 560 Series Direct3D11 vs_5_0 ps_5_0, D3D11)", false],
  ["ANGLE (AMD, Radeon (TM) RX 460 Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)", false],
  ["ANGLE (AMD, AMD Radeon RX 580 2048SP Direct3D11 vs_5_0 ps_5_0, D3D11)", true],
  ["ANGLE (AMD, AMD Radeon RX 5600 XT Direct3D11 vs_5_0 ps_5_0, D3D11)", true],
  ["ANGLE (AMD, AMD Radeon RX 6500M Direct3D11 vs_5_0 ps_5_0, D3D11)", true],
  ["ANGLE (AMD, AMD Radeon 780M Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)", false],
  ["ANGLE (AMD, AMD Radeon Pro 555X OpenGL Engine, OpenGL 4.1)", false], // 原先偏宽（2018 款 MBP）
  ["ANGLE (AMD, ANGLE Metal Renderer: AMD Radeon Pro 560X, Unspecified Version)", false],
  ["ANGLE (AMD, ANGLE Metal Renderer: AMD Radeon Pro 450, Unspecified Version)", false],
  ["ANGLE (AMD, ANGLE Metal Renderer: AMD Radeon Pro 580, Unspecified Version)", true], // iMac，约等于 RX 580
  ["ANGLE (AMD, ANGLE Metal Renderer: AMD Radeon Pro 5500M, Unspecified Version)", true],
  ["ANGLE (AMD, ANGLE Metal Renderer: AMD Radeon Pro Vega 20, Unspecified Version)", true],
  ["ANGLE (Intel, ANGLE Metal Renderer: Intel(R) UHD Graphics 630, Unspecified Version)", false],
  ["ANGLE (Intel, Intel(R) Arc(TM) A370M Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)", false], // 原先偏宽
  ["ANGLE (Intel, Intel(R) Arc(TM) A380 Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)", false],
  ["ANGLE (Intel, Intel(R) Arc(TM) A750 Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)", true],
  ["ANGLE (Intel, Intel(R) Arc(TM) B580 Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)", true],
  ["ANGLE (Intel, Intel(R) Arc(TM) 140V GPU (16GB) Direct3D11 vs_5_0 ps_5_0, D3D11)", false],
  ["ANGLE (Apple, ANGLE Metal Renderer: Apple M4 Pro, Unspecified Version)", true],
  ["ANGLE (Apple, ANGLE Metal Renderer: Apple M2 Ultra, Unspecified Version)", true],
  ["ANGLE (Apple, ANGLE Metal Renderer: Apple M4, Unspecified Version)", false],
  ["Radeon R9 200 Series, or similar", false],
  ["ANGLE (Qualcomm, Adreno (TM) X1-85 Direct3D11 vs_5_0 ps_5_0, D3D11)", false],
];
let bad = 0;
for (const [r, want] of cases) {
  const got = isHighEndGpu(r);
  if (got !== want) bad++;
  console.log(`${got === want ? "✓" : "✗"} ${got ? 2048 : 1024}  ${r}`);
}
console.log(bad ? `${bad} 条不符` : "全部符合");
process.exit(bad ? 1 : 0);
