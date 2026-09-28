// C10c 交付版的对照变体（页面跑交付版 src）：给 C10c-mkjobs.mjs --vfile C10c-var3.mjs
//   cur / cur2 = 交付版（A/A 噪声底）；c10b = 删掉「挪受光求值点」那一行（= master 的 C10b：其余改动是注释与 uLoopGuard）；
//   old = C10（进云二分 + 空白 2dt + 上限 192，同样不挪），取 C10b-var2 的 OLD 补丁再加「不挪」
import { VARIANTS as V } from "./C10b-var2.mjs";
const SHIFT = "        p -= rd * (min(0.3 * stepLen, 4.0 / kv) * smoothstep(1.0, 3.0, sigL));\n";
const NOSHIFT = [SHIFT, ""];
export const VARIANTS = {
  cur: [], cur2: [],
  c10b: [NOSHIFT],
  old: [...V.old, NOSHIFT],
};
