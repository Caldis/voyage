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
];
let bad = 0;
for (const [r, want] of cases) {
  const got = isHighEndGpu(r);
  if (got !== want) bad++;
  console.log(`${got === want ? "✓" : "✗"} ${got ? 2048 : 1024}  ${r}`);
}
console.log(bad ? `${bad} 条不符` : "全部符合");
process.exit(bad ? 1 : 0);
