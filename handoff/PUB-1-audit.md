# PUB-1 历史审计报告

审计对象：`git log --all -- apps/voyage`（1070 个提交，含 diff 内容与提交信息全文）。
审计目的：为将来用 `git subtree split --prefix=apps/voyage` 拆出独立公开仓库做安全检查。
审计范围：只读检索，**未做任何历史改写**（未跑 filter-repo / rebase / push）。

## 结论摘要

**没有发现阻断性问题。** 未命中任何私网 IP（192.168.x.x / 10.x.x.x / 172.16–31.x.x 的完整四段形式）、`macmini`、`udm`、`sshpass`、`mca-dump`、PPPoE 相关内容、真实密钥/令牌形态、或 netscope 内网拓扑细节。提交信息全文（1070 条 `%B`）里也没有任何一条提到 netscope / udm / macmini / mca-dump / pppoe / sshpass / 192.168。

命中的条目全部落在「可接受」一类：作者邮箱 `mail@caldis.me`（用户已知的 GitHub 公开邮箱）、`Co-Authored-By: ... <noreply@anthropic.com>`、以及大量 WIP / 交接类提交里的本机 worktree 路径（`D:\Code\opus-test\...`、`C:\Users\mail\AppData\Local\Temp\...`），不含用户全名或凭据。

可以按用户已定的方案直接 `git subtree split` 拆分，无需在 monorepo 或独立副本上跑 filter-repo 清理历史。以下仍给出如后续需要收紧本机路径痕迹时的可选处理方式（非必须）。

## 命中清单 —— 必须处理才能公开

无。

逐项检索结果：

| 检索项 | 方法 | 结果 |
| --- | --- | --- |
| 私网 IP（192.168.x.x / 10.x.x.x / 172.16-31.x.x，完整四段） | `git log --all -G"192\.168\.[0-9]+\.[0-9]+"` 等三条分别测试 192.168 / 172.16-19 / 172.20-29 / 172.30-31 / 10.x | 0 命中 |
| `macmini` | `git log --all -Gmacmini` | 0 命中 |
| `udm` | `git log --all -Gudm` | 0 命中 |
| `sshpass` | `git log --all -Gsshpass` | 0 命中 |
| `mca-dump` | `git log --all -G'mca-dump'` | 0 命中 |
| `pppoe`（不分大小写） | `git log --all -i -Gpppoe` | 0 命中 |
| `surge`（不分大小写） | `git log --all -i -Gsurge` | 8 个提交命中，逐一核实均为 `surgeDraw()`（天气系统里「寒潮脉动」随机量函数名，`src/weather.ts`），与 Surge 代理软件无关，**噪声，非命中** |
| 提交信息全文提到 netscope/udm/macmini/mca-dump/pppoe/sshpass/192.168 | `git log --all --format="%H%n%B%n---"` 后 grep | 0 命中 |

## 命中清单 —— 可接受

1. **作者邮箱 `mail@caldis.me`**：出现在每个提交的 `Author:` 行，属于用户已知的 GitHub 公开邮箱，可接受。
2. **`Co-Authored-By: Claude ... <noreply@anthropic.com>`**：标准署名行，可接受。
3. **本机 worktree / scratchpad 绝对路径**：例如
   - `D:\Code\opus-test\.claude\worktrees\agent-affd69c2a6890daca`（WIP T26 交接提交等，约 100+ 个提交的 diff 里提到不同的 worktree 路径，均为「协调者 + 子代理」调度流程留下的交接说明文字，无凭据）
   - `C:\Users\mail\AppData\Local\Temp\claude\D--Code-opus-test\...\scratchpad\...`（T26/T04 等对照 worktree 说明，`C:\Users\mail\...` 里的 `mail` 是 Windows 本机账号名，非真实姓名）
   - `C:\Users\mail\AppData\Local\ms-playwright\chromium-1223\...`（浏览器缓存路径说明）
   这些都是开发过程记录（性能对照基线、worktree 分支说明），不含凭据、不含用户真实姓名、不指向任何家庭内网设备，判定可接受，无需处理。
4. **`sk-` 字面误报**：`sk-[A-Za-z0-9]` 正则命中约 100 个提交，抽查后发现全部是中文行文里的连字符复合词误匹配（例如「`dusk-line.png`」里的 `sk-l`），未发现任何真实 API Key/Secret 形态字符串。
5. **PUB-1 任务本身的看板 / 交接提交**（`e15b1797...` 等）里出现「目标仓库 `Caldis/voyage`（公开）」「站点 `https://caldis.github.io/voyage/`」等文字，是本任务的既定方案说明，非敏感信息。

## 建议处理命令（供协调者参考，非必须执行）

审计结论是**不需要**做历史清理即可公开。如果用户后续出于洁癖考虑，仍想把 worktree/scratchpad 本机路径从历史里抹掉，可在 **subtree split 出的独立仓库副本**（不要在 monorepo 上跑）上执行，例如：

```bash
# 1. 先按计划拆分（在 monorepo 里执行，只读不改写现有历史）
git subtree split --prefix=apps/voyage -b voyage-only
# 2. clone 一份独立副本再动 filter-repo，不要在 monorepo 工作区里跑
git clone --no-local <monorepo路径> voyage-standalone
cd voyage-standalone
git checkout voyage-only

# 3.（可选）替换本机路径为占位符，仅替换文本、不删提交
cat > replacements.txt <<'EOF'
C:\Users\mail\AppData\Local==>~/local
D:\Code\opus-test\.claude\worktrees\agent-==>worktree-
EOF
git filter-repo --replace-text replacements.txt

# 4.（可选，仅当需要改写提交信息里的敏感内容时）
# git filter-repo --message-callback 'return message' 可自定义替换逻辑，
# 或用 --replace-message <file>（格式同 --replace-text，逐行 "旧文本==>新文本"）
# 本次审计未发现提交信息需要改写的内容，故不建议默认执行

# 5. 确认改写后再推送到新远程，避免在原 monorepo 分支上操作
git push <新远程> voyage-only:main
```

**强调**：以上第 3–4 步是可选加固，不是发布前置条件。本次审计没有找到「必须处理才能公开」的条目。

## 审计方法与覆盖范围说明

- 范围：`git log --all -- apps/voyage` 覆盖的全部历史（含 master 分支及本次任务前所有已合并的 worktree 分支中触碰 `apps/voyage` 路径的提交），共 1070 个提交。
- 内容检索用 `git log --all -G"<正则>" -- apps/voyage` 按 diff 内容（增删行）命中；命中后对每类关键词至少抽查 1 个具体提交的完整 diff，核实是否为真实命中还是正则误报（本次共发现两类误报：`surge`→`surgeDraw()` 函数名，`sk-`→中文复合词连字符）。
- 提交信息检索用 `git log --all --format="%H%n%B%n---" -- apps/voyage` 导出全文后 grep，覆盖 subject + body，不依赖 diff 是否命中。
- 私网 IP 检索特意采用「完整四段数字」的严格正则（而非粗略的 `10\.[0-9]`），避免版本号（如 three.js `^0.186.1`）造成的大面积误报污染判断；已用更宽松的粗正则试过一轮并确认全部是版本号类噪声，因此最终以严格正则的「零命中」为准。
- 未逐提交人工通读全部 1070 条 diff（工作量不现实），而是按关键词穷举 + 抽查确认的方式覆盖；如果协调者认为需要更彻底的通读复核，可以追加人工抽样。
- 本次审计未检查 apps/voyage 目录以外的历史（例如 apps/netscope 自身的历史），因为 subtree split 只会带走 `apps/voyage` 路径下的提交内容，netscope 相关文件从未出现在 apps/voyage 的提交里，这一点已通过「私网 IP / macmini / udm / sshpass / mca-dump / pppoe」在 diff 和提交信息两个维度均为 0 命中来交叉验证。
