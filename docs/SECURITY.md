# v0.1.3 安全整改证据与阻塞项

日期：2026-10-14；宿主固定 v3.9.1 / SDK 3.9.0。未修改上游或 WorldState，未使用真实密钥，未发送私人账户请求。当前只支持固定模拟业务数据与假凭据安全存储。

## 源码核查：认证签名仍阻塞

链路：插件 network.request → [宿主 scoped API](https://github.com/wealthfolio/wealthfolio/blob/v3.9.1/apps/frontend/src/addons/addons-runtime-context.ts) → [共享网络适配器](https://github.com/wealthfolio/wealthfolio/blob/v3.9.1/apps/frontend/src/adapters/shared/addon-network.ts) → Tauri addon_network_request → [核心网络](https://github.com/wealthfolio/wealthfolio/blob/v3.9.1/crates/core/src/addons/network.rs)。核心 send/chunk 错误直接转字符串，reqwest 请求错误可能带完整 URL。返回失败再由 [Tauri 通用 invoke](https://github.com/wealthfolio/wealthfolio/blob/v3.9.1/apps/frontend/src/adapters/tauri/core.ts) 写原始错误日志，早于插件捕获。

[核心网络审计](https://github.com/wealthfolio/wealthfolio/blob/v3.9.1/crates/core/src/addons/service.rs) 的 write_network_audit_entry 仅存主机/方法/状态或错误码，不保存 query、body、headers。这部分审计是克制的，但不能保护另一条 invoke 错误日志。不能笼统宣称所有宿主日志泄露，也不能因 network-audit 不含 query 就判定全链路安全。

已运行临时模拟 HTTP 故障服务器和 SDK/reqwest 风格错误替身负对照：返回错误包含虚构 signature URL，宿主替身先记录，插件显示固定文案无法撤回记录；阻断门不调用服务器或宿主，日志集合为空。仅在测试进程用 Node HTTP，不是插件访问 localhost，没有修改/绕过官方代理，也没有新增生产服务。

**未运行官方 Rust/Windows 网络故障全链路**：实际插件没有 network 权限，官方禁止 localhost，本轮没有可批准的自有 HTTPS 故障测试服务。替身不是官方日志安全证明。当前无法保证签名 URL 必要保护，真实认证继续阻断；需要上游日志脱敏修复或经批准的官方代理假请求复验。不得关闭所有日志掩盖问题。

## secrets 范围与失败语义

[SDK 桥接](https://github.com/wealthfolio/wealthfolio/blob/v3.9.1/apps/frontend/src/addons/addons-runtime-context.ts) 固定插件 ID，不接受另一个插件 ID。[secrets 命令](https://github.com/wealthfolio/wealthfolio/blob/v3.9.1/apps/tauri/src/commands/secrets.rs) 再构造 addon_service_id，写新键后可能因旧格式清理失败报错。不能把 SDK set 当跨键事务。

[资料库 ScopedSecretStore](https://github.com/wealthfolio/wealthfolio/blob/v3.9.1/crates/core/src/profiles/mod.rs) 给新资料库加 profile UUID 前缀；legacy 资料库保留旧前缀；[Windows 实现](https://github.com/wealthfolio/wealthfolio/blob/v3.9.1/apps/tauri/src/secret_store.rs) 使用原生凭据存储。本插件只用固定本插件 key，保存假密钥对和指针；没有普通 storage 的凭据副本，没有 use 权限。

两个槽位避免覆盖旧版本；候选完整读回才切换。单点候选/读回/切换故障可保留旧活动版本。若 OS 连旧指针恢复也拒绝，无法承诺活动状态原子回滚；旧槽仍保留，明确错误并持续阻断认证。断开标记先于删槽，所有值读回 null 后才报告删除完成。SDK 替身故障测试不能代替原生凭据库的故障注入。

重启默认断开，凭据存在不等于请求获准。现在只有固定假版本，无真实输入或连接入口。未来真实密钥会短暂进入插件内存，当前 SDK 没有 Binance HMAC 托管；不能宣称从不进入 JS。卸载和本地删除不等于撤销币安密钥，应明确提示用户在币安端撤销。

## 数据与时效

fixture 保留手算；external 解析入口不继承模拟报价/成本或 demo 标识。外部入口只在脱敏单元样例中运行，没有外部数据持久化/恢复/导出/宿主写入。稳定来源身份与 API Key 分离，重复来源拒绝计入。

默认余额 60 秒、报价 120 秒、FX 300 秒，均检查未来时间；这是保守测试策略，实际接口频率和真实价格口径仍需审查。采集起止与 asOf、价格 asOf、FX asOf 分离。过期结果只保留旧数量/历史范围，不参加当前估值。

多 external 快照或 fixture/external 混合不发布当前或历史合计，批次统一也不证明划转一致。跨钱包对账/原子采集未实现。Funding 只保存四原始字段，不生成 quantity/total 或量化 Snapshot；缺字段拒绝。Stocks 继续 unsupported。不同钱包持有的同一资产保留账户数量。

导出逐字段模拟白名单；未知字段丢弃，自由名称/原因/报价来源不透传任意字符串。恢复遇未知字段拒绝、正常旧 v1 迁移到 formatVersion=2。当前只批准 BTC/USDT 固定样例，真实备份须另行设计审核，不自动增加字段。

## AI 隔离证据与首次真实测试配置

设置是**按当前资料库**： [AI 命令](https://github.com/wealthfolio/wealthfolio/blob/v3.9.1/apps/tauri/src/commands/ai_providers.rs) 用 ProfileAccess；[服务初始化](https://github.com/wealthfolio/wealthfolio/blob/v3.9.1/apps/tauri/src/context/providers.rs) 使用该资料库 settings_repository 和 secret_store 创建 AiProviderService、chat repository。不是一个独立资料库就自动禁用 AI 的保证，也不替代实际配置核对。

[工具默认规则](https://github.com/wealthfolio/wealthfolio/blob/v3.9.1/crates/ai/src/types.rs) 包含持仓、账户、现金等；None/未配置不是拒绝，而是默认许可。[流式执行](https://github.com/wealthfolio/wealthfolio/blob/v3.9.1/crates/ai/src/chat/streaming.rs) 用当前 Provider allowlist 过滤工具，空数组才没有获准工具。账户工具还可能扩展到现金/组合，持仓扩展到净资产，不只关三个可见名称。旧聊天的历史结果仍可进入模型上下文，改白名单不撤回已发送资料。

首次真实测试前，由用户在该测试资料库逐项执行并保存读回：

1. 设置 → AI 提供商，关闭 DeepSeek 及所有外部 Provider，不保留可用默认外部模型。只改本资料库，不删除 Provider 密钥/聊天，也不修改其他资料库。
2. 每个 Provider 的数据/工具权限全部取消，保存后确认为空白名单（不是默认/未配置）。覆盖账户、现金、持仓、组合、净资产、交易、业绩等所有工具；不要只凭一个“读取持仓”开关判定隔离。
3. 不使用助手、旧聊天、附件、CSV 导入到聊天或资产导出上传。现有旧会话不用于真实测试；不擅自删除它们。同步停止、重启再核实权限。
4. 设置 → AI 代理访问，核实 MCP/PAT 等外部代理不能读取测试资料库；存在凭据/配置时先让用户确认处理，不由插件绕过主程序授权。
5. 仅使用固定模拟资料做权限验证。若需进一步用假聊天验证无工具访问，应由用户明确允许向选定外部模型发送这组固定测试文本/模拟资料；本轮没有发送 AI 消息。

本插件权限不会限制主程序内置 AI。关闭 Provider、空 allowlist 能控制后续工具路径，但不能保证历史附件/缓存/已经发送内容撤回，不能充当整个软件的网络隔离。**当前未验证实际 DeepSeek 权限保存与拒绝调用，也未修改设置；AI 隐私验收仍是首次真实接入阻塞项。** 若发现宿主某项为全局设置，须先说明影响并请求用户确认；本轮不做全局变更。

2026-10-14 Windows 只读检查：在 WRISK Windows 验收 20261013 的 AI 提供商页，OpenAI 兼容 Provider 开关开启，模型列表含 deepseek-flash / deepseek-v4-pro；账户（包含现金）、持仓（含净资产）、交易、绩效、收入、目标、配置、分类、历史九项数据访问均为勾选。没有点击开关、揭示密钥、请求模型列表或发送聊天。仅证明当前配置不满足首次真实测试隔离，并不证明实际请求路由到哪个域名。是否按资料库隔离的结论来自官方源码；本轮没有在两个资料库修改开关验证独立性。

## 下一轮最小建议

先将代码、SECURITY 与 VALIDATION 交 Astra 复审。只做官方代理假签名故障链路和资料库 AI 拒绝读工具的独立验收；日志未解决前不申请真实 Key。Funding 口径、内部划转一致性、Stocks 继续阻塞，不能因为 Spot 单账户样例通过就宣称三类账户可用。
