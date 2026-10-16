# 架构与边界

## v0.2.0 当前产品架构

DirectSpot保留已验收的认证路径，只增加公开行情独立调度和会话历史参考。SpotQuoteReader仅接network能力、资产代码与时钟；当前/历史报价分开，市场映射有限缓存，ticker要求TRADING。portfolio-view是只读展示模型；PortfolioOverview负责总值/覆盖、四列持仓、配置及详情，DirectSpotPanel负责连接交互。DeveloperWorkbench仅显式进入时挂载。

余额默认手动或本人开启5分钟自动；行情每1分钟自动，独立退避但共用SDK单飞/限流/页面生命周期。余额6分钟、报价2分钟；当前估值继续使用原calculateRisk与Decimal，不给历史参考绕过TTL。成本未接入，平均成本和收益率不可用。

公开缓存15分钟有效市场/3分钟无市场；32请求、20回退、100候选限制保持。报价结果原子替换；历史参考不持久化、不进入备份或主账本。完整行为、限制、官方来源及成本方案见[产品交付说明](PRODUCT-0.2.0.md)。以下v0.1.14及更早段落为历史。

## 2026-10-16 当前真实Spot连接路径

v0.1.14保留原风险、凭据、严格余额解析和界面，只局部简化DirectSpot。官方secrets读回后，api.binance.com公开time最多3次，第一个合格样本返回；仍拒绝>2000ms、>60000ms偏移及>250ms墙钟跳变。不再依赖MARKET主机或强制凑齐3样本；只有已结束宿主失败、HTTP 5xx网络错误及慢样本可重试，认证请求不自动重放。

每次余额查询先签名GET apiRestrictions核实纯只读，再签名GET account，严格解析并核对预期UID，立即替换单账户快照。失败保留历史且当前不可用；合法空余额才为零。首次成功后可手动refreshQuotes；它不读secrets、不修改余额成功状态，不沿用失败报价，也不阻塞首次列表。5分钟自动仅更新余额，行情过期仍缺价。DirectSpot通过PublicMarketReader.isBusy统一在途门，隐藏/断开终止后续报价请求；已发SDK请求无法撤回，晚到429/418依然冷却。

当前宿主3.10.0仍存在reqwest错误URL→Tauri invoke日志路径。本轮用户再次接受本机剩余风险，未修改宿主或TLS/代理；插件不能把自身脱敏当作宿主日志已修复。无主账本写入、外部AI调用或真实数据备份。参见[本轮依据与验收](CONNECTION-REVIEW-20261016.md)。以下版本段落是历史边界。

v0.1.5 增量：spot-quotes.ts 解析模拟 exchangeInfo → 明确的资产/USDT 市场映射 → 单币/100 symbols 分批 ticker GET 构造 → 标准 Price。只有 TRADING 且 Spot allowed 的唯一 USDT 市场可用；非 USDT/停牌/歧义/缺价保留缺口，不截后缀猜身份。ticker 无成交时间，Price.asOf 是采集时刻，沿用 120 秒 TTL；USD 转换仍需独立 FX，本版没有。

SpotOfflineReader 继续仅 mock，不持有 ctx.api.network。v0.1.6 单独公开行情模块见文末，不改变离线认证传输。非 USDT -20% / USDT 同币种 0% 是明确测试情景，未知法律类型不伪装普通币或真实 Stocks。SpotHoldingsTable 直接用风险报告的 eligiblePositionKeys 显示当前金额/权重/损失，过期或缺价行仍显示数量和历史报价。旧基准与新会话隔离，备份不扩展。v0.1.5 已完成 Windows 验收，v0.1.4 自身未复验；各版本以 VALIDATION 最新节为准，下文保留历史边界。

## 模块与数据流

v0.1.3：新增 credentials.ts（仅假凭据、官方 secrets 双槽、认证硬阻断）与 backup.ts（白名单清洗/严格恢复）。binance.ts 的 fixture 入口与 external Spot/Funding 原始字段入口分开。旧 host.ts 导入仅保留离线回归，不再由页面或清单授权。

```text
固定币安响应 → binance.ts 标准化 → fixtures.ts 补充固定报价
              → domain.ts 完整批次替换 → 风险纯函数 → addon.tsx 页面
插件状态 → 官方 storage → 独立 JSON 导出/恢复
官方 secrets 假凭据 → SpotOfflineReader → mock time/account/ticker 响应
  → Spot 标准快照 → 带 TTL 的通用风险函数 → 单账号 Spot 页面（仅内存）
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

本节的 host 导入是历史能力及保留的离线契约，不是 v0.1.4 当前可调用路径。

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

v0.1.4 新增 spot.ts 与 spot-fixture.ts。只构造 GET time/account/ticker，没有可配置主机/方法/路径。时间响应使用请求中点，拒绝 >2 秒 RTT、>60 秒偏移或倒退时钟；以校准毫秒签名，recvWindow=5000。账户采集起止不使用 updateTime，后者不是当前余额的证明。ticker/price 无成交时间，本轮记录报价接收时间，不声称证明上游价格新鲜度。

响应 UID 决定身份，换假 Key 不增仓，已有会话 UID 变化拒绝。纯标准化区分 fixture/external；external 不带模拟标识、报价或成本，资产类型 unknown。固定模拟只审核 BTCUSDT 映射，USDT=1 USDT 是同币种计价，其余资产保留缺价。单 Spot 完整覆盖不代表整个 Binance 资产，Funding/Stocks 没有新请求或账户设置。

enforceFixtureFreshness 只给新模拟链路增加时效检查，不给 external 绕过 TTL；旧固定基准保持默认行为。401/403/签名/时钟无自动重试，429/418 冷却，超时中止 mock signal；断开世代标记拒绝新请求和在途结果。工厂标记只防错误注入，不是恶意代码沙箱。真实入口调用原无条件阻断门，控制器不持有 ctx.api.network。

新 Spot 会话不持久化、不导出，现有白名单只备份旧模拟基准。页面每 10 秒重算，不采集；删除假凭据按钮先调用 disconnect。没有改变 SDK/依赖、主程序数据库、旧资产或 AI 配置。

A 股以后添加官方连接器或 CSV 标准化入口即可复用风险函数；具体券商权限/持仓接口仍需单独调查。现在没有券商代码或复杂抽象。主程序升级可能改变 SDK 签名、权限检测、宿主 React 版本、路由、快照日期规则或备份范围；按固定版本重新验收，不自动跟随最新版本。
## v0.1.6 公开行情增量

src/public-market.ts 独立接收SDK network.request能力，不接收ctx/secrets/认证读取器。只构造指定主机三个公开GET，exchangeInfo限定五个市场避免2MiB宿主响应限制；复用spot-quotes映射与十进制价格校验。body字符串有限长度JSON解析，状态/限流/固定错误分类；无直连fetch、后台请求或服务器。

数据流：手动刷新→time→exchangeInfo→ticker/price→external来源/采集时间报价→fixture固定数量快照→通用风险纯函数。采集起止是报价请求时间，不是私人余额采集时间；表头明确区分。120秒过期、失败/断开不发布当前值；历史报价仅作历史参考。缺行不沿用上次价格，保留模拟数量并显示partial。USDT1只是同币计价，不建立USD汇率。

状态仅内存，卸载页面断开；不写主程序/storage/旧备份。SDK没有AbortSignal，15秒UI超时后仍阻止重叠请求直到宿主promise结束；断开epoch拒绝迟到结果。仅允许手动重试。宿主精确批准主机/HTTPS/禁止重定向；插件固定GET/路径，不能说宿主权限也限制了路径。证据见 PUBLIC-MARKET-PREP；模拟断网不是 OS 或原生网络故障验收。

## 本机 Spot 凭据准备

`BinanceCredentials` 只使用独立的 `risk-binance-spot-*` secrets 键；界面只显示是否已保存，输入框为密码型非受控字段，保存后立即清空。它不写普通 storage 或模拟导出。

`buildOfflineReadRequest` 只构造 Spot `GET /api/v3/account`，测试使用虚构凭据与工厂 mock。实际认证入口没有 network 参数并保持硬阻断。`mergePublicSpotPrices` 只从成功且未过期的 v0.1.6 公开行情提取价格，保留 external 余额数量，删除旧价；USDT 按 USDT 计价单位处理，缺行情资产保留未定价。

## v0.1.8 用户批准的本地只读交接

native/SpotReader.cs是独立Windows进程，只有WinForms、DPAPI及.NET HTTP。凭据在CurrentUser加密文件中候选核验后原子替换；不读取Wealthfolio的secrets，不监听端口。默认fixture模式不发认证；显式--allow-live及界面确认只供用户下一轮授权后使用，固定HTTPS api.binance.com GET time/account，预期UID与响应核对。宿主日志漏洞未修复，本方案让宿主完全不接触认证请求。

用户主动复制余额白名单JSON→spot-bridge.ts验证格式/UID/mode/起止/60秒TTL→单一账户替换快照→public-market.ts共用赋价（不复制模拟数量）→原通用风险函数→独立页面。fixture和external不混合；其他UID拒绝；未知、缺价、过期和失败语义保持。非法导入会将旧快照标记失效；辅助程序失败状态必须手动交接，否则插件只能等旧快照TTL到期。状态仅页面内存，没有宿主写入或真实备份。

插件撤下v0.1.7真实凭据输入，保留旧secrets代码/虚构测试回归；权限不扩展，公开行情仍官方代理。UI每10秒重算，不发后台余额请求；只限五个已审核市场，其他资产缺价。JSON的来源标记不是加密身份认证，余额剪贴板仍是资产隐私；Windows同用户恶意进程、调试与OS追踪不在DPAPI/应用固定错误码的保护承诺内。内置AI/DeepSeek配置未变，不以“仅内存”宣称所有AI隐私隔离已经通过。

native/SpotReader.SelfTest.cs只在显式自检时启动临时loopback假服务器，凭据固定虚构、输出fixture，不是产品服务或宿主网络绕过。Windows Actions执行96项插件测试和原生自检，产物全部留在artifacts。运行界面不会开放自定义URL、header、脚本或交易接口。

## v0.1.9 当前主要链路（用户新决定）

保留以上历史方案和备用读取器，不继续扩展EXE。direct-panel.tsx本人本机密码框→既有BinanceCredentials官方secrets候选核验切换→DirectSpot会话明确授权→官方network.request：公开time校准、签名apiRestrictions白名单、签名account→既有spotSnapshot校验UID及十进制数量→独立PublicMarketReader取已授权五个市场→既有赋价/通用风险→独立真实表格。每次先验证Key权限，非只读或缺字段时不查余额；不调用snapshots.save，不复制模拟数量，没有成本/收益字段。不拷贝参考项目实现。

真实secrets与固定dummy键隔离，真实数量/UID/同意和自动开关只在会话内存，不进入storage/备份/日志。每次替换凭据先断开；首次由本人接受签名URL可能进宿主本地日志的剩余风险，不能描述为已修复。旧requestAuthenticated、SpotOfflineReader仍拒绝真实发送；新直接路径单独授权，不把mock transport换成宿主。

DirectSpot负责5分钟间隔、6分钟TTL、单飞、限流及失败退避、epoch防迟到发布；页面只有一个1秒检查/绘制定时器，不是每秒联网。官方3.10.0 detachRoute只hideFrame（iframe尺寸0、visibility hidden），不保证React卸载。因此同时监听document visibilitychange、窗口resize及自身viewport非零，不能只依靠useEffect清理。onDisable断开，重启新会话无同意/自动状态；secrets存在不触发请求。切页/最小化/返回行为仍须以当前宿主实机验收记录为准；SDK不能取消已发请求，超时后pending直到底层结束，不重叠。

## v0.1.9界面分区

正式默认页只消费DirectSpot的标准化真实会话和原RiskReport，格式化仅用于展示；未知/缺价/失效不改为零。连接设置使用原secrets/四确认流程，不把凭据值存React状态；连接成功不渲染输入。原模拟模块整体置于默认关闭的原生details内，无新增路由/依赖。details关闭不删除已有状态或持久化键。

DirectSpot新增诊断元数据getter，按既有步骤标记阶段及固定安全码；不改变签名、请求、权限门、同步策略和风险职责。UI只翻译白名单码，未知码显示UNKNOWN而非任意异常。开发区与正式区不共享持仓来源；所有旧回归仍由smoke检查。

## v0.1.10诊断与重试修复

request在受限正文内先解析整数code再分类；DirectRequestError只携带固定SpotError、HTTP状态及整数业务码，无原始响应/请求/cause。非JSON仍按HTTP分类，429/418在底层响应返回时记录独立cooldownUntil，包括SDK超时/epoch失效后的迟到响应。普通failures/due只控制自动退避，disconnect/authorize可清理普通状态，不能清除限流。retry元数据明确区分限流、普通退避、在途、待本人确认、隐藏和可重试；不增加请求端点或自动重试次数。冷却当前仅会话内保存，不保证跨进程延续。

ReadOnlyError只含固定原因和必要已知字段/布尔状态，缺字段不猜false；所有旧权限策略保留。isSaved仅读取非密钥活动标记，未查询时不读Key/Secret槽。价格展示用Decimal完整有效小数，只有市值/损失格式化两位；资产计算与来源隔离不变。

## v0.1.11用户决定与显示修正

## v0.1.12校时与请求诊断

## v0.1.13余额解析与安全校验路径

官方GET account的uid为整数、accountType示例SPOT、balances为asset/free/locked数组；保留JS安全正整数UID，不接纳已失精的int64或改用预期UID兜底。free/locked按既有非负十进制字符串规则，缺失/负数/重复/错误类型不发布快照。官方明确响应可能含UTF-8资产名，已移除纯ASCII限制；身份原样保留，不规范化、不合并。资源边界为非空、至多128码点/256UTF-8字节且无控制/格式/分隔/孤立代理字符，非币安官方长度声明。合法零记录完整校验后才从非零持仓省略，未知非零资产保留并缺价，不增加行情源或改变报价计算。

SpotValidationError与SnapshotValidationError只携带固定层级、结构路径和原因。请求包装区分非文本、超限、JSON无效、HTTP失败；超限JSON未解析时不谎报JSON无效。成功HTTP/JSON元数据在后续账户/快照错误中保留；新请求开始清空元数据，宿主拒绝不得继承此前权限请求的200。界面白名单检查原因/路径/层级；SPOT_INVALID主提示与原诊断区同时给安全摘要。未知本地解析异常标SNAPSHOT_BUILD_FAILED/snapshot，明确尚无具体根因，不带原始异常或字段值。

依据：[官方account格式](https://developers.binance.com/docs/binance-spot-api-docs/rest-api/account-endpoints)、[官方UTF-8说明](https://developers.binance.com/docs/binance-spot-api-docs/rest-api/general-api-information)。只查公共文档，未抓取真实响应。

### 以下为v0.1.12诊断记录

DirectSpot原请求包装保留单飞、晚到限流和断开/隐藏保护，新增固定失败层级：plugin-timer、host-call、http-response；不解析宿主String、不保留原始异常/cause。校时本地拒绝使用clock-validation及ClockError四原因，只携带耗时/偏移/时间字段有效性。performance.now与签名Date.now分离，墙钟与单调耗时差超过250ms拒绝；原2秒往返、60秒偏移与recvWindow=5000不放宽。三次串行校时选合格最低耗时，非慢样本错误立即停止。

公开testPublicTime只能在未连接、可见、无在途且无交易所冷却时手动执行；仅两个硬编码主机的GET /api/v3/time，不能传入路径/header/body。完全不读secrets、不授权会话、不采集余额或报价。每主机最多3次，传输/HTTP失败停止该主机，限流/在途超时/断开停止全部。安全观察最多6条只存页面内存，原连接设置诊断区显示；不新增存储或页面。

### 以下为v0.1.11显示与用户决定记录

用户明确接受独立小额纯只读无强制IP白名单：仅删除ipRestrict===true条件，保留此字段必须boolean及其他完整/严格只读检查。未知true权限继续拒绝，不改变端点、HMAC、数据与账本边界；四确认权限说明增加无IP隐私风险。

输入区显示改按success而非connected：authorize只表示开始尝试，不能卸载UID/密码/确认DOM；首次进行中/失败保留，同一页面重绘不因连接标志变化卸载，成功快照后隐藏。-2008只新增固定auth分类与安全说明，不携带原始msg，不为定位读取现存密钥。此前所谓“已有凭据”提示改为“存有但尚未验证”。
