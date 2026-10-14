# 架构与边界

## 模块与数据流

v0.1.3：新增 credentials.ts（仅假凭据、官方 secrets 双槽、认证硬阻断）与 backup.ts（白名单清洗/严格恢复）。binance.ts 的 fixture 入口与 external Spot/Funding 原始字段入口分开。旧 host.ts 导入仅保留离线回归，不再由页面或清单授权。

```text
固定币安响应 → binance.ts 标准化 → fixtures.ts 补充固定报价
              → domain.ts 完整批次替换 → 风险纯函数 → addon.tsx 页面
              → host.ts 正式 SDK → 主程序 HOLDINGS 账户/快照/模拟报价 → 读回
插件状态 → 官方 storage → 独立 JSON 导出/恢复
```

- `domain.ts`：平台无关账户、资产、快照、状态、汇率与风险函数，无网络/SDK/React。
- `binance.ts`：现货/资金响应解析，HMAC 和只读请求构造；不发送私人 API 请求。
- `fixtures.ts`：固定、可手算数据；股票仅有未支持状态。
- `host.ts`：只使用官方 SDK 的最少方法；不直接操作数据库/文件系统/主程序内部对象。
- `addon.tsx`：入口、中文页面、按钮与状态；React 根由主程序管理。

SDK / 开发工具精确锁到 3.9.0（来自 v3.9.1 仓库）；React 等宿主依赖外置，Decimal.js 与 HMAC 库打包。没有本地服务或外部数据库。ZIP 内是清单、ES 模块、CSS、说明。

## 数据身份与计量

账户来源身份：platform + sourceAccountId + kind；内部 id 与上游标识分离。资产身份：venue + code + type + quoteCurrency。同一资产跨账户保留独立数量，风险层按完整资产身份汇总；股票、代币化证券和加密货币不会仅凭同名代码合并。

快照含账户 id、batchId、asOf、fixture/external 标识。余额分解是可选来源元数据，不要求其他交易平台使用 Binance 桶。`liquidity` 为可选简单元数据，可将来记录 T+1、涨跌停、停牌，当前没有执行逻辑。标准化器仅将固定样例 BTC/USDT 分类为 crypto；其他代码保持 unknown 和无报价，不凭现货接口或后缀猜测 bStocks。USD 是本阶段明确的报价目标，不是原始余额接口提供的价格。

报价、汇率有币种/来源/时间。external 采集起止时间必需，asOf 等于结束时间；默认余额 60 秒、价格 120 秒、FX 300 秒有效期（保守测试策略，时钟可注入，并非生产口径）。未来数据同样失效。fixture 为固定手算样例，不可用于外部资产。实时获取及证券公司行为未实现。

所有风险金额用 40 位精度 Decimal，输出金额 8 位小数、权重/HHI 6 位。统一估值 = 数量 × 报价 × 明确汇率。HHI = 权重平方之和；压力损失 = -Σ(估值 × 冲击比例)。只报告当前成功且可估值范围的比例与压力结果；任何账户未覆盖/失败/缺价时完整总资产为 null。

v0.1.2 不再用空集合求和结果代表有效估值：没有 ready 有效快照，或当前持仓全部缺少价格/汇率时，coveredSubtotal 与 stressLoss 返回 null。查询成功的空快照或有可靠报价的零数量仍返回 0；零分母的权重/HHI 为不可用。coverage 区分 unavailable/partial/complete，currentAccountIds 与 unpricedPositionCount 明示覆盖范围，不改变批次替换规则。部分账户失效时只计算 ready 快照；失效持仓不参与当前风险。

lastKnownSubtotal 是保留快照可估值部分，无历史或全部无法估值也返回 null；lastKnownSnapshotTimes 提供所有保留快照时间，lastKnownPartial 标记覆盖/估值/批次不完整。它不是最近一次完整账户总资产的持久化缓存，也不是当前实时资产。页面始终单列历史说明和时间；多时间时显示时间集合，不假定同一时点。

## 同步与主程序写入

模拟批次要求预期账户齐全、账户身份匹配、batchId/asOf 一致，随后替换旧快照。失败保留上一批数据并标记当前不可用，防止划转过程中拼接新旧账户。

演示导入仅接受 fixture、完整 Spot/Funding 批次及受控 BTC/USDT；专用模拟账户和 WRISKDEMO 资产避免修改真实 BTC 全局报价模式。官方主程序生成账户 UUID，插件使用返回值，并通过 providerAccountId 与所有权标记复用账户；重复来源或所有权不匹配时拒绝写入。当前映射保存至 host-account-map-v1。`snapshots.save` 导入数量，`quotes.update` 写测试报价，`portfolio.update` 重算，`snapshots.getByDate` 核对数量。没有采购成本证据，所以 averageCost=0 表示未知演示成本，不拿价格伪造收益。

多个账户的宿主保存不是插件级原子事务。写入前持久化 pending，全部写入/读回后 verified；失败记录 failed 并显式提示可能部分写入。重复运行同一天可修复并核对，但没有承诺跨账户原子回滚。真实同步开发前需确定对账/写入策略。

v0.1.1 桌面暴露的失效数字 0 问题已由 v0.1.2 的风险返回值和显示修复。仍保留的边界：缺价历史小计不是最近完整估值；宿主操作提示是临时页面状态，重开恢复「尚未执行」不等于持仓丢失。模拟 averageCost=0 会使主程序收益栏显示虚假高收益，只验证数量、估值和风险，不将该栏作为收益证据。

## 安全与备份

v0.1.3 只申请 secrets.set/get/delete 与 files.openSaveDialog，无真实输入。SDK 加插件命名空间，原生宿主再加资料库范围与 OS 凭据存储。整个假 Key/Secret 对及槽指针都在 secrets；普通 storage 只存清洗后的 fixture。候选读回才切换，切换失败恢复旧指针；若恢复也失败，旧槽保留但活动状态不可保证，返回待核对错误，认证仍阻断。没有 OS 多键事务或 JavaScript 内存可靠清零保证。

删除先存断开标记，再删两个槽并读回 null，最后删指针；失败保持断开并允许重试。保存、读取、重启都不启用认证。卸载/删除不撤销交易所密钥。

本版撤下 network、主机声明、公开探测及主程序资产读写入口。认证函数无条件拒绝，不读取凭据或调用代理。离线签名不能证明宿主日志安全。网络和 AI 源码证据见 SECURITY。

external 不允许 demo 来源、WRISKDEMO 或固定报价；账户按 platform/sourceAccountId/kind 去重，API Key 不决定身份。Funding 不返回量化 Snapshot。多 external 或 fixture/external 混合不发布当前/历史合计；相同批次及时间也不能证明原子采集。真实多钱包一致性未实现。

插件 storage SQLite 持久化、按插件隔离、更新保留、卸载清除；当前每项约 250 KB。便携导出清除 addon storage。JSON 逐字段模拟白名单，formatVersion=2，正常 v1 可读；未知字段导出丢弃、恢复拒绝，文案本地批准，数值/身份/时间校验。external 导出和持久化尚未开放，恢复不写主程序；真实备份需另行审计。

## 维护与扩展

A 股以后添加官方连接器或 CSV 标准化入口即可复用风险函数；具体券商权限/持仓接口仍需单独调查。现在没有券商代码或复杂抽象。主程序升级可能改变 SDK 签名、权限检测、宿主 React 版本、路由、快照日期规则或备份范围；按固定版本重新验收，不自动跟随最新版本。
