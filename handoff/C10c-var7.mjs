// C10c 复测：od 近段减量在 cu-side / variety / graze-sc 上比 master 贵约 4%（gpu-final3）。拆开价钱：
//   nosub = 去掉减法（odNear、odCut 都成死代码）；fullod = 用整段 od 的一半作上限（不记 odNear）
const SUB = "        od -= min(0.5 * odNear, odCut / CLOUD_EXTINCTION);\n";
const NEAR = "          if (j == 2) odNear = od; // 前 3 步（约 240 m）：进云那一步的 odCut 只从这一段里减（C10c，见上）\n";
export const VARIANTS = {
  cur: [], cur2: [],
  nosub: [[SUB, ""]],
  // flat：本地「上」取 (0,1,0)（60 km 内地球曲率 < 0.6°），省掉 length(p) 与两次点积
  flat: [
    ["        vec3 upP = p / length(p);\n        float kv = dens * CLOUD_EXTINCTION * max(-dot(rd, upP), 0.05) / max(dot(uKeyDir, upP), 0.05);\n",
     "        float kv = dens * CLOUD_EXTINCTION * max(-rd.y, 0.05) / max(uKeyDir.y, 0.05);\n"],
  ],
  fullod:[[NEAR, ""], [SUB, "        od -= min(0.5 * od, odCut / CLOUD_EXTINCTION);\n"]],
  // nobr：不分支，按标志乘 0 / 1（去掉进云步的发散分支）
  nobr: [
    ["      if (wasEmpty && i > 0) {\n#endif\n        vec3 upP", "      {\n#endif\n        vec3 upP"],
    ["        odCut = min(0.4 * stepLen * kv, 3.0) * smoothstep(1.0, 3.0, sigL);\n",
     "        odCut = min(0.4 * stepLen * kv, 3.0) * smoothstep(1.0, 3.0, sigL) * ((wasEmpty && i > 0) ? 1.0 : 0.0);\n"],
  ],
  // late：只记一个标志，受光步进之后才算 odCut
  late: [
    ["      float odCut = 0.0;\n#ifdef CLOUD_WEATHER\n      if (stormW < 0.5 && fine == 0 && wasEmpty && i > 0) {\n#else\n      if (wasEmpty && i > 0) {\n#endif\n        vec3 upP = p / length(p);\n        float kv = dens * CLOUD_EXTINCTION * max(-dot(rd, upP), 0.05) / max(dot(uKeyDir, upP), 0.05);\n        float sigL = dens * CLOUD_EXTINCTION * stepLen;\n        odCut = min(0.4 * stepLen * kv, 3.0) * smoothstep(1.0, 3.0, sigL);\n      }\n",
     "      bool entryCut = wasEmpty && i > 0;\n"],
    [SUB, "        if (entryCut) {\n          vec3 upP = p / length(p);\n          float kv = dens * CLOUD_EXTINCTION * max(-dot(rd, upP), 0.05) / max(dot(uKeyDir, upP), 0.05);\n          od -= min(0.5 * odNear, min(0.4 * stepLen * kv, 3.0) * smoothstep(1.0, 3.0, dens * CLOUD_EXTINCTION * stepLen) / CLOUD_EXTINCTION);\n        }\n"],
  ],
};
