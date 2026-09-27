// passes.mjs --variants：同页对照云步进 C01 前后（old = 受光段改回原文）。new2 / old2 只多一个空格式差异，
// 让同一份源码第二次出现时也真的换一次程序（交替测两轮）
import { OLD_MS, NEW_MS } from "./C01-ab.mjs";
const K = ["const float CLOUD_MS_ALBEDO = 6.0;", "const float CLOUD_MS_ALBEDO = 6.00;"];
export const VARIANTS = [
  ["new", []],
  ["old", [[NEW_MS, OLD_MS]]],
  ["new2", [K]],
  ["old2", [[NEW_MS, OLD_MS], K]],
];
