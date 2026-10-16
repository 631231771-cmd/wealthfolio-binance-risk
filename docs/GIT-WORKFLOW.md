# 私有仓库与 AI 接力

唯一工作目录：`F:\Code\风控`。
仓库：[631231771-cmd/wealthfolio-binance-risk](https://github.com/631231771-cmd/wealthfolio-binance-risk)，2026-10-14曾确认Private；2026-10-16重新通过GitHub API核实isPrivate=false，当前公开。本轮不改变仓库可见性。

- `main` / `v0.1.3`：已验证的旧模拟安全基线；源码基线提交 `91f3432`。
- `feature/spot-readonly-offline`：v0.1.4 基线 dbdf2cd、v0.1.5 基线 f07cf33；现为 v0.1.6 公开行情增量。未合入 main；安装包只是本地产物，不发布 Release。
- Git 作者只在本项目设置为 GitHub 用户名与 GitHub noreply 邮箱；不改变全局配置。登录凭据由 gh 原生管理，不写项目。

当前产品开发分支：`feature/dynamic-spot-quotes`，本轮明确授权正常提交/推送；不创建PR、不合main、不发布Release。

## 继续任务

1. 阅读 CURRENT 和 AGENTS，然后检查 `git status --short`、`git branch --show-current` 与 `git log -3 --oneline`。
2. 先确认是当前路径、分支和预期 origin；有他人未提交改动时保留，不能重置、覆盖或自动丢弃。
3. 只看相关提交差异与模块；不要每次复制上游或完整审计全部项目。
4. 修改行为后增加必要测试，更新 CURRENT / 验证记录，再执行 `npm run verify`。
5. 提交前逐个检查 `git diff` 和 `git diff --cached`，只加入相关源码、测试、配置及已清洗文档。固定假凭据与公开 HMAC 向量是测试材料，不允许真实密钥。
6. 获得该轮提交/同步授权后再提交并 `git push origin 当前开发分支`；本轮已获用户明确授权。不得强推、改历史、自动合并 main 或公开仓库。
7. 登录失效时让用户在本机完成 `gh auth login --hostname github.com`，不要在聊天中索取 Token。可先做本地开发与提交，授权后再推送。

## 禁止入库

`.env*`、credentials/secrets、本地 Key/证书、宿主 DB/账户/个人备份、data/runtime/backups、node_modules、dist、缓存、日志、artifacts 和 ZIP；`提示词.md` 是本地任务文件，也排除。

忽略规则不是敏感信息检测：每次仍需审查拟提交内容，不能因为仓库 Private 就上传个人资产。安装包、构建记录与供 Astra 使用的补丁留在本地 artifacts。旧 v0.1.3 ZIP 原样保留。
