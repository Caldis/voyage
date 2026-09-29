# PUB-1：独立仓库 + GitHub Pages 部署准备

任务范围：只做审计与「让 apps/voyage 能独立构建部署」的改动，**不创建远程仓库、不推送、不改写历史**。推送、开 Pages 由协调者执行。

## 一、历史审计

见 [`handoff/PUB-1-audit.md`](PUB-1-audit.md)。结论：**没有阻断性问题**，全部 1070 个历史提交（diff + 提交信息）都没有命中私网 IP / macmini / udm / sshpass / mca-dump / PPPoE / 密钥令牌等敏感内容，可以直接按计划 `git subtree split` 拆分，无需先做 filter-repo 历史清理。

## 二、本次改动（都在 `apps/voyage/` 目录下）

| 文件 | 改动 |
| --- | --- |
| `apps/voyage/.gitignore` | 新增，覆盖 node_modules / dist / .vite / *.log / tmp/ / .playwright-mcp/ / __pycache__/ / *.tsbuildinfo，独立仓库后不会把临时文件带进历史 |
| `apps/voyage/package.json` | 加 `"packageManager": "pnpm@10.32.1"`（与根一致） |
| `apps/voyage/pnpm-lock.yaml` | 新增，在 monorepo 工作区**外**（临时目录）跑 `pnpm install --ignore-workspace` 生成，独立仓库拆出后可直接 `pnpm install --frozen-lockfile` |
| `apps/voyage/vite.config.ts` | 加 `base = process.env.VOYAGE_BASE \|\| "/"`；本地开发 / monorepo 内构建不传这个变量，行为不变；CI 传 `VOYAGE_BASE=/voyage/` |
| `apps/voyage/src/sky-assets.ts` | 银河图 / 星表 / 月面纹理的 3 处 `fetch("data/...")` 改成 `` `${import.meta.env.BASE_URL}data/...` ``，显式基于 base，不依赖相对 URL 隐式解析 |
| `apps/voyage/src/rail/data.ts` | `loadRailData` 的默认 `base` 参数同样改成基于 `import.meta.env.BASE_URL`；`scripts/audio-check.mjs` 里显式传参的调用不受影响 |
| `apps/voyage/.github/workflows/pages.yml` | 新增。拆分后会落在新仓库根的 `.github/workflows/pages.yml`：pnpm/action-setup → setup-node → `pnpm install --frozen-lockfile` → `VOYAGE_BASE=/voyage/ pnpm build` → upload-pages-artifact → deploy-pages，权限 `pages` + `id-token`，触发 push 到 `main` 与手动 `workflow_dispatch` |
| `apps/voyage/README.md` | 顶部加「独立仓库使用」一节：`pnpm install && pnpm dev`、在线地址 `https://caldis.github.io/voyage/`、EOX 影像 CC BY-NC-SA 4.0 非商用的署名提示 |

**审计发现**：其余本地资源引用（`new Worker(new URL("./x.worker.ts", import.meta.url))`、`index.html` 里 `/src/main.ts` `/src/style.css`）都由 Vite 在构建期自动按 `base` 重写，不需要手动改；`ground/tiles.ts` 里的 `fetch` 都是外部瓦片服务（`tiles.openfreemap.org`、EOX 等绝对 URL），与本地路径 / base 无关，未动。

未碰 `src/ui.ts`、`index.html` 的面板部分、`src/wonders/`（UX-5、WS09 在途）。

## 三、验证结果

### 3.1 独立副本构建（工作区外，scratchpad 临时目录，已清理）

```
pnpm install --ignore-workspace   # 生成 pnpm-lock.yaml
pnpm install --frozen-lockfile    # 复查锁文件可复现
VOYAGE_BASE=/voyage/ pnpm build   # tsc --noEmit && vite build
```

结果：`tsc --noEmit` 通过；`vite build` 产物 `dist/index.html` 里资源引用正确带 `/voyage/` 前缀（`/voyage/assets/index-*.js`、`/voyage/assets/index-*.css`）；`find dist -type f -size 0` 无 0 字节文件。

**Windows 坑点**：Git Bash（MSYS）会把形如 `/voyage/` 的环境变量值当作 Unix 路径自动转换成 Windows 路径（`VOYAGE_BASE=/voyage/` 在 Bash 工具里实测被转成 `C:/Program Files/Git/voyage/`，导致 vite 报「"base" option should start with a slash」的告警且路径不对）。**验证 `VOYAGE_BASE` 这类以 `/` 开头的环境变量时必须用 PowerShell 设置**（`$env:VOYAGE_BASE = "/voyage/"`），不要在 Git Bash 里直接 `VOYAGE_BASE=/voyage/ pnpm build`。GitHub Actions 跑在真正的 Linux bash 里，没有这个问题，workflow yaml 不用改。

### 3.2 子路径部署验证

用一个极简 Node 静态服务器（临时脚本，已删除）把 `dist/` 挂到 `http://127.0.0.1:4577/voyage/`，Playwright 打开 `?dev=1&voyage=0`：

- 首屏正常渲染（机翼、云层、太阳、面板都在，见截图 `tmp/screenshot/pub1-subpath.png`）
- 控制台 0 error（8 条 warning 都是已知的 ANGLE/FXC 着色器编译告警，如 `X3595 gradient instruction`、`X4000 uninitialized variable`、`X4008 division by zero`，与本任务改动无关，非本次引入）
- 本地静态资源全部 200：`/voyage/data/milkyway_4k.jpg`、`/voyage/data/bsc5.json`、`/voyage/data/moon_2k.jpg`、3 个 Worker（`spectrum.worker` / `tile-compose.worker` / `road-raster.worker`）
- 外站请求（EOX 502 次、OpenFreeMap 191 次、AWS Terrain Tiles 28 次、NASA GIBS 25 次）在本次测试环境里全部 200，没有观察到 CORS 问题；这是运行环境的网络条件，不是本次改动的结论范围，实际 GitHub Pages 环境仍可能出现外站限流 / CORS，与之前 README「坑点」里记录的 EOX 限流问题一致，不算本任务失败项

### 3.3 monorepo 内回归

- `pnpm typecheck`（含 roadmap + voyage）：通过
- `pnpm --filter voyage build`（根路径，无 `VOYAGE_BASE`）：通过，`dist/index.html` 资源仍是根路径 `/assets/...`，`find apps/voyage/dist/assets -type f -size 0` 无 0 字节文件
- `node scripts/lint-shaders.mjs`（即 `check:glsl`）：全部通过
- `pnpm install`（monorepo 根）：不受 `apps/voyage/pnpm-lock.yaml` 影响，`Lockfile is up to date, resolution step is skipped`
- 本地 `pnpm dev:voyage`：Playwright 打开根路径，控制台 0 error，面板与画面正常

**事故记录（已处理，无遗留影响）**：验证本地 dev server 时，worktree 里跑 `pnpm dev` 因为端口 5181 已被别的进程占用，vite 自动切到 5182；我在收尾阶段按端口号 5181 批量 `Stop-Process` 时误杀了一个**不属于本次任务、运行在主仓库 `D:\Code\opus-test\apps\voyage` 的既有 dev server**（很可能是协调者或别的会话留下的）。该进程在几秒内自动重新监听 5181（可能有外部的自动重启机制），复查确认 `curl http://127.0.0.1:5181/` 恢复 200，未造成数据丢失，但**记录为教训**：清理进程时要按精确 PID／命令行匹配自己启动的进程，不要用端口号做批量匹配，避免误杀协调者或其他并行 worktree 的服务。本次任务结束前只清理了自己在 5182 上的 dev server 进程。

## 四、给协调者：首次推送与开 Pages 的推荐命令

以下命令本次任务**未执行**，仅供协调者在确认无误后自行操作。

```bash
# 1. 在 monorepo（master 分支，确认工作区干净）里做只读的 subtree split
git checkout master
git subtree split --prefix=apps/voyage -b voyage-standalone

# 2. 建一个新的公开远程仓库（GitHub 网页或 gh CLI），确认仓库名 = voyage，Owner = Caldis，Visibility = Public
gh repo create Caldis/voyage --public --description "航行伴侣：模拟从交通工具窗口看出去的风景" -y

# 3. 推送拆分出的历史到新仓库的 main 分支
git push https://github.com/Caldis/voyage.git voyage-standalone:main

# 4. 打开新仓库的 Settings → Pages，Source 选 "GitHub Actions"
#    （.github/workflows/pages.yml 已经在拆出的内容里，推送后 Actions 会自动跑一次）
gh api repos/Caldis/voyage/pages -X POST -f build_type=workflow

# 5. 推送完成、Pages 部署成功后再本地清理
git branch -D voyage-standalone   # 只删本地这个 split 出来的分支，不影响 master
```

**推送前请协调者自行复核**：
- `apps/voyage/handoff/PUB-1-audit.md` 的审计结论（本报告认为不需要，但请协调者按需再抽查）
- `gh repo create` 的 `--public` 是用户明确要求的（本次系统提示与任务描述都写明「仓库公开」），执行前建议跟用户口头确认一次仓库名与命名空间
- Pages 部署完成后，实机打开 `https://caldis.github.io/voyage/?voyage=0` 走一遍 3.2 节同样的检查（控制台 0 error、资源 200），因为真实 GitHub Pages 环境的外站网络条件和本次验证用的本地环境可能不同

## 五、开发体验反馈

- `VOYAGE_BASE=/voyage/ pnpm build` 这类命令在 Git Bash 下会被 MSYS 路径转换坑一次，而且报错信息（"base" option should start with a slash）具有一定误导性，看起来像是配置写错了，实际是环境变量的值被换成了 Windows 路径。这条已经记进本文件 3.1 节，也建议以后 voyage 的 README「环境坑」或根 AGENTS.md「环境坑（Windows）」里补一条通用提示：**任何以 `/` 开头的环境变量值，在 Git Bash 里赋值前测一下 `node -e "console.log(process.env.X)"`，不放心就用 PowerShell 设置**。因为任务描述里点名"不改 TASKS / WORKLOG / ROADMAP / DEV_SOP"、且这条更像是通用环境坑而非 voyage 专属坑，这次先只记在本交接文档里，留给协调者判断要不要提升到 AGENTS.md。
- 按端口号杀进程在多 worktree 并行开发场景下很危险（本次的误杀事故），建议以后清理自己起的开发服务器一律记住自己那条命令返回的 PID，不要用端口/关键词反查再批量杀。
- 任务本身的分工很清楚（A 审计 / B 改代码 / 验证 / 交付），审计部分派给了 fork 子任务并行做，没有额外来回。整体顺畅。
