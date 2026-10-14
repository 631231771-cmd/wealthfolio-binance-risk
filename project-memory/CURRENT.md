# 当前状态

日期：2026-10-14。唯一根目录 F:\Code\风控。源码/本地包 v0.1.4；官方 Wealthfolio v3.9.1 已安装插件仍为 v0.1.3。

## 已完成且验证

- Spot 单账号离线链路：固定 GET time/account/ticker、时间校准、HMAC、响应验证、free+locked、UID 去重、独立价格及通用风险。
- 官方 secrets 固定假凭据；无真实输入。真实发送硬阻断，清单仅 secrets.set/get/delete 与 files.openSaveDialog，无网络或宿主资产权限。
- 新会话 fixture，仅内存不保存/导出，不与旧基准相加。24000 USDT，BTC -20% 损失 4000 USDT；USDT 不假定 USD 平价。Funding 未覆盖、Stocks unsupported，整个 Binance 总额不可用。
- 完整 verify 65 项测试/类型/构建/ZIP/6 种旧状态显示通过。19 项新测试覆盖认证/403/429/签名/时钟/超时、取消/并发、价格、零、时效、UID/来源；旧 30000 USD / 5500 USD 不回归。
- 本轮未操作客户端/测试数据库/DeepSeek；v0.1.4 Windows 未安装或交互验收。v0.1.3 secrets/重启实测留在 VALIDATION，不能冒充新版本实测。
- 仓库 https://github.com/631231771-cmd/wealthfolio-binance-risk 已确认 Private；main/v0.1.3 基线 91f3432，开发分支 feature/spot-readonly-offline，提交推送以 Git 为准。接力见 docs/GIT-WORKFLOW.md。
- 包 artifacts/wealthfolio-binance-risk-0.1.4.zip，校验 BUILD-RECEIPT.json；旧 v0.1.3 ZIP 未覆盖。精简 docs/REVIEW-PACKET.md + artifacts/v0.1.3-to-v0.1.4.patch。

## 未解决的真实接入阻塞

- 官方 v3.9.1 reqwest/invoke 原始 URL 日志风险未修复；mock 不是原生链路安全证明，认证继续拒绝。
- AI 首次真实资料须禁用外部 Provider、空工具白名单、隔离旧上下文并实测拒绝；本轮没改设置。原生 secrets 故障与真实只读权限未实测。
- 真实 Spot 分类/价格完整性/上游时效、对账与真实备份未验收；当前只审核 BTC/USDT 模拟映射。
- Funding 四桶、跨钱包划转一致性和 Stocks 持仓/现金能力未验证。

## 下一步唯一优先任务

由用户将 REVIEW-PACKET 和增量补丁交 Astra 复审，再决定官方假签名/AI 隔离验收；未经批准不输入真实密钥、不启用网络或真实 Spot。
