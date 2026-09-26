# 着色器编译时间专项（开发体验官）

> 状态：**中间结论**（ANGLE 后端实测已完成；特性隔离原型、拆分评估、缓存命中、业界对照仍在做，完成后本文件整体改写）。
> 实测环境：Windows 11，RTX 5090（驱动 616.64），Chromium 148.0.7778.96（Playwright 缓存的完整 chrome.exe，新版 headless，真实 GPU），
> 视口 1600×1200，主分支 dev server 5181（commit fa77f8d）。真冷启动 = 每个着色器注入随机 nonce 强制缓存不命中。本机 GPU 同时被其他代理占用（采样时占用 12–58%），数字有噪声。

## 中间结论：ANGLE 后端

| 后端（`--use-angle=`） | 真冷启动总耗时 | 其中场景+机翼编译 | 画面（noon-cumulus） | 能用吗 |
| --- | --- | --- | --- | --- |
| `d3d11`（Windows 默认，FXC） | **97.7 s** / 102.9 s（两次） | 后台编译 88.2 s + 首帧 7.6 s | 基准 | 能用，就是慢 |
| `vulkan` | **5.4 s** / 6.4 s（两次） | 首帧同步编译 3.9–4.4 s（该后端不支持 `KHR_parallel_shader_compile`，编译在首帧里做） | 与 d3d11 一致：舱内、天空平均差约 0.1 级灰度；差异只在随时间动的海面和云（两次截图的时刻不同） | **能用，快约 18 倍** |
| `gl`（WGL 上的 NVIDIA OpenGL） | 不可用 | 场景程序链接失败 `VALIDATE_STATUS false`（日志为空），画面全黑 | — | 不可用 |

结论：**开发时用 Vulkan 后端，改一次着色器从约 1.5 分钟降到约 5 秒。** 不用改任何代码。

### 两个后端的关键差异（这是切换的主要风险）

| 项 | d3d11 | vulkan |
| --- | --- | --- |
| `MAX_TEXTURE_IMAGE_UNITS` | **16**（场景着色器已用满 16/16） | 32 |
| `MAX_FRAGMENT_UNIFORM_VECTORS` | 1024 | 4096 |
| `KHR_parallel_shader_compile` | 有 | **没有**（编译阻塞主线程，但总共才几秒） |
| FXC 专属问题（循环展开导致编译暴涨、`X3595` 分支/循环里的导数、超时丢上下文） | 会出现 | **不会出现** |

也就是说：在 Vulkan 上开发，**第 17 个 sampler、超 1024 的 uniform、FXC 编译暴涨、X3595 都不会报错**，而用户和默认 Chrome 走的是 d3d11。
所以 Vulkan 只能当「开发内循环」，交付前的验收（冷编译预算、sampler 计数、控制台无 error）仍必须在 d3d11 上做一次。

### ANGLE / Chrome 有没有降低 FXC 优化级别的开关

在 chrome://gpu 里列出的 ANGLE D3D11 全部 feature（约 55 个，见 `tmp/screenshot/dx-shader/gpuinfo-d3d11.txt`）里**没有**任何控制 FXC 编译标志或优化级别的项；
相关的只有 `cacheCompiledShader`、`disableProgramCaching` 这类缓存开关。结论：浏览器侧没有「开发态降优化」的开关，只能换后端或改着色器本身。
（ANGLE 源码里 FXC 的具体标志与回退逻辑见下文「业界与源码对照」，待补。）

### 给用户：现在就能做

**推荐做法（不影响日常浏览）**：单独开一个开发专用的 Chrome 窗口，只在这个窗口里用 Vulkan：

```powershell
# 独立的用户目录，不动日常 Chrome 的配置和 flags
& "C:\Program Files\Google\Chrome\Application\chrome.exe" --user-data-dir="$env:LOCALAPPDATA\voyage-dev-chrome" --use-angle=vulkan http://127.0.0.1:5181
```

打开后在地址栏输入 `chrome://gpu`，搜 `GL_RENDERER`，看到 `ANGLE (NVIDIA, Vulkan ...)` 就说明生效了。

**另一种做法（全局切换，日常浏览器也跟着变）**：地址栏打开 `chrome://flags/#use-angle` →「Choose ANGLE graphics backend」选 **Vulkan** → 点右下角 Relaunch。改回来选 Default。
风险：影响所有网页（视频、其他 WebGL 网站）；Windows 上 Vulkan 后端不是 Chrome 默认路径，遇到驱动问题时可能个别网页花屏或崩 GPU 进程；
更重要的是上面那张差异表——会把 d3d11 才有的问题藏起来。所以更推荐单独的开发窗口。

**交付前**：仍在默认（d3d11）浏览器里打开一次，确认冷编译预算、控制台无 error（DEV_SOP 的验收不变）。
