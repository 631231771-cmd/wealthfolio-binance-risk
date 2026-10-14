# v0.1.4 精简审查材料

日期 2026-10-14；Wealthfolio 3.9.1 / SDK 3.9.0。只审本文件、增量补丁和必要上游链路。

## 相对 v0.1.3

基线 tag v0.1.3 / 提交 91f3432；开发分支 feature/spot-readonly-offline，包版本 0.1.4。
新增 spot.ts / spot-fixture.ts、19 项测试与简单页面区；风险函数只增加可选 fixture 时效检查。未改 SDK/依赖、宿主、旧资产、secrets 实现、备份格式或 AI 设置。

## 关键源码起始行

| 文件:行 | 审查点 |
|---|---|
| src/spot.ts:7 | 固定 time/account/ticker GET 白名单 |
| src/spot.ts:21 | mock 工厂；WeakSet 不是恶意代码沙箱 |
| src/spot.ts:24 | 固定错误分类，不透传原消息 |
| src/spot.ts:36 | 时间中点、RTT/偏移限制 |
| src/spot.ts:49 | 使用字段白名单、UID/资产/数量/重复验证 |
| src/spot.ts:61 | fixture/external 分开，无默认外部报价/成本 |
| src/spot.ts:75 | USDT 风险与 fixture TTL，不隐含美元汇率 |
| src/spot.ts:82 | 单账号内存、替换去重、真实 requestReal 硬阻断 |
| src/spot.ts:97 | 超时/断开世代；异常不透传 URL/header/body |
| src/spot.ts:107 | 固定假凭据门；time→account→独立价格；UID 冲突拒绝 |
| src/domain.ts:153 | 余额时效，external 永远检查 |
| src/domain.ts:186 | 价格/FX 时效，缺估值不静默为零 |
| src/addon.tsx:10 | 单账号页面、10 秒重算、明确覆盖范围 |
| src/addon.tsx:92 | 删除前断开 Spot，不接受在途结果 |
| src/spot-fixture.ts:4 | 固定响应，无宿主网络 |
| tests/spot.test.ts:23 | 新增链路测试 |
| scripts/smoke-package.mjs:40 | 编译包禁止 fetch/storage/network.request，权限不增加 |

必要旧代码：src/binance.ts:15 签名构造，src/credentials.ts:73 硬阻断，tests/security.test.ts:127 模拟日志负对照。无需重复读全部历史文档。

## 实际测试

- 本机 npm run verify：65 项，0 失败；类型/构建/ZIP/6 种旧风险状态编译入口通过。
- 新样例：0.4 BTC × 50000 USDT + 4000 USDT = 24000 USDT；BTC -20% 损失 4000 USDT。不是 USD，也不包含 Funding。
- 旧 30000 USD / 5500 USD 不回归。v0.1.3 ZIP SHA256 801b27e64f2876bbcab33562bf3599b0b689eda32c82cb5bc431155db18703dc 未变。
- 401/403/429/签名/时钟/超时失败保留数量，但当前小计/压力 null；限流不重试；报价失败不继承旧报价；真实空成功是 0。
- 换假 Key 不增仓；UID 改变拒绝；并发/断开/在途结果测试通过。凭据/签名不进入状态，新会话不能进入旧备份格式。
- external 仅脱敏函数测试；无真实发送。没有调用公开/私人 Binance，没有网络权限。
- v0.1.4 Windows 安装/交互未执行，客户端及测试资料仍为 v0.1.3；旧实测不能代替新版本实测。

## 签名日志风险仍阻塞

2026-10-14 再核官方固定 tag：
- [network.rs:103](https://github.com/wealthfolio/wealthfolio/blob/v3.9.1/crates/core/src/addons/network.rs#L103)、121：reqwest 错误直接 to_string。
- [tauri/core.ts:55](https://github.com/wealthfolio/wealthfolio/blob/v3.9.1/apps/frontend/src/adapters/tauri/core.ts#L55)：插件捕获前记录原始错误。
- [Binance GET 规则](https://github.com/binance/binance-spot-api-docs/blob/master/rest-api.md#general-information-on-endpoints)：参数在 query，不能未经验证改 POST 或移入 GET body。

最小上游方向：代理返回前移除 reqwest URL（例如 without_url），仅返回批准的错误码，并检查其余日志。必须官方发行版落地，再通过官方代理向批准的自有 HTTPS 服务发送假签名、注入故障、检查原生日志。**本项目未改宿主，不声称此方案已实现。** SDK 未有已验证托管 HMAC；插件 catch 脱敏、关闭日志或审计不含 query 都不能消除此风险。

本版有效保护是不发送：无 network 权限、宿主发送器、真实输入，requestAuthenticated 无条件拒绝。原 mock 日志正负对照只是模型测试，不是官方代理修复证明。

## 真实 Spot 前最少确认

1. 官方日志保护及假请求全链路通过；未通过不授权真实认证。
2. 用户在独立资料库禁用全部外部 AI Provider、工具空白名单，实测拒绝账户/现金/持仓；不使用旧聊天/附件，不改其他资料库。本轮没改配置。
3. 复审后另行授权官方代理及真正凭据生命周期；币安端只读、不启用交易/提现/划转；原生错误泄露测试。
4. 确定小规模真实 Spot 对账、资产分类/价格覆盖/时效、真实备份边界。本版仅 BTC/USDT 模拟映射，ticker 接收时间不证明成交时刻。

Funding 四桶口径、跨钱包一致性及 Stocks 不阻止未来只放行单 Spot，但必须继续未支持，不能宣称整个 Binance 完整资产。

## 交付

包 artifacts/wealthfolio-binance-risk-0.1.4.zip；校验见 BUILD-RECEIPT.json。
精简差异 artifacts/v0.1.3-to-v0.1.4.patch，仅源码/测试/安全清单，不含全套文档、锁文件或上游代码。
Private 仓库 https://github.com/631231771-cmd/wealthfolio-binance-risk，main 保留基线，开发分支不自动合并。runtime/data/凭据/数据库/备份/日志/ZIP/本地任务排除。

结论：可交增量复审，尚不能真实 API 接入。完成后停止。
