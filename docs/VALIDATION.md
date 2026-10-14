# 验证记录

日期：2026-10-13。环境：Windows PowerShell、Node 24.17.0、npm 11.13.0；Wealthfolio SDK/开发工具 3.9.0，对应目标桌面 v3.9.1。

## 已执行

- `npm run typecheck`：通过，正式 SDK 类型约束。
- 原 v0.1.0 `npm test`：24 项通过、0 失败。v0.1.1 补充宿主生成 ID 与复用残留账户回归检查后为 **25 项通过、0 失败**；含手算、重复同步、划转、失败保留、混合批次拒绝、缺价、身份、未分类资产、FX、备份、HMAC 与宿主替身。
- `npm run build`：通过，输出 ES 模块入口和 CSS。
- `npm run package`：生成插件 ZIP；仅含 manifest.json、dist/addon.js、dist/wealthfolio-binance-risk.css、README.md；已读回清单和路径检查。
- `npm run smoke`：编译入口成功加载，路由与清单匹配，页面静态渲染通过；没有直接 fetch 或浏览器 storage。

完整验证入口：`npm run verify`。包 SHA256 见同目录交付的 `artifacts/BUILD-RECEIPT.json`（生成产物，不入版本控制）。

宿主替身测试仅验证本插件对官方 SDK 的调用契约与防重复/失败路径，不运行上游 Rust、数据库或 Windows WebView。风险和签名测试都是离线固定样例。

## 未执行

- 官方桌面的公开网络代理连通。
- 真实 Binance 现货/资金 API 请求、读取权限、余额桶口径对账。
- Binance Stocks 完整只读持仓/现金 API。

官方桌面核心数据路径已实测通过；v0.1.1 的异常数字显示已由 v0.1.2 修复并复验。桌面备份恢复、控制台及真实接口仍未验证。下面保留各版本历史，不把先前缺陷或未验证项写成当前已完成。

当前 v0.1.3 安全整改最新结果见末节。新增官方 secrets 假凭据 Windows 验证；网络日志与 AI 隐私仍阻塞真实连接，旧版本宿主写入权限不能作为当前授权。

## 工作目录迁移

2026-10-13：完整项目迁至 `F:\Code\风控`。3558 个原有文件的迁移前后 SHA256 全部一致，包含依赖与所有下载产物。应用源码和既有安装包未改动；工作目录说明及下载记录中的当前保存路径更新至新位置。迁移明细见 `artifacts/MIGRATION-RECEIPT.json`，既有包内部文档保留原构建快照。

迁移后在新目录执行类型检查、24 项测试及编译入口静态渲染，全部通过；客户端安装包和插件 ZIP 的 SHA256 仍与此前记录一致。没有重新开发 PoC、重新打包或执行客户端安装。

## v0.1.1 Windows 桌面真实验收（2026-10-13，历史记录）

以下是本轮后续的实际结果，不是 SDK 替身。Windows 11 x64，官方 Wealthfolio v3.9.1，路径 `E:\Wealthfolio\Wealthfolio.exe`；读回 FileVersion/ProductVersion 均为 3.9.1。原官方下载及校验来源在 `artifacts/Wealthfolio-v3.9.1-download-receipt.json`。

通过官方个人资料流程新建 **WRISK Windows 验收 20261013**，USD；先确认空资料 0 个账户/0 条持仓。只向此资料写入模拟数据，没有修改、删除或覆盖原 Personal 资料数据库，没有购买、订阅或启用 Connect。全部桌面操作经原生 UI，没有修改主程序或通过私有接口操作数据库。

### 最小故障修复与安装

v0.1.0 安装、路由、风险页面成功，但宿主导入失败并留下一个空模拟 Spot 账户。插件错误假定可指定宿主账户 ID；官方 v3.9.1 `crates/storage-sqlite/src/accounts/repository.rs` 的 create 始终生成 UUID，此前替身错误回显传入 ID。

v0.1.1 仅修正 host.ts：使用返回 ID，以 providerAccountId + 所有权标记复用来源账户，保存映射，拒绝重复来源/身份冲突；修正替身、新增回归测试、更新版本及构建记录脚本。失败留下的空账户已复用，没有删除数据库或增加重复来源账户。

修复后 `npm run verify` 全部通过（类型、25 测试、构建、ZIP、静态入口）；继续验收时再次 typecheck/test/smoke 通过。后续仅更新文档，不再打包，保留实际安装 ZIP：

`F:\Code\风控\artifacts\wealthfolio-binance-risk-0.1.1.zip`

SHA256：`2afb88b0080d6e423b3a894cbe51bc1191a4c12dc54600c824666e5a99270714`。原 0.1.0 ZIP 和构建记录保留；包内 README 为构建快照。BUILD-RECEIPT 中 desktopInstallation=未完成是打包当时状态，实际结果以本文及 WINDOWS-ACCEPTANCE-RECEIPT 为准。

用户亲自批准安装两个版本。重启后管理器显示 **1 个已安装插件，v0.1.1**，侧栏和独立页面正常。已安装权限页列出 accounts.getAll/create、portfolio.getHoldings/update、snapshots.save/getByDate、quotes.update、network.request、files.openSaveDialog；没有 secrets 权限或真实密钥输入。账户、持仓、报价调用已实测；文件导出未实测。

权限页网络主机 `api.binance.com` 显示 **已拒绝**。本轮未更改授权、未点击公开网络检测、未请求 Binance；清单声明不等于已授权或连通。控制台未检查，页面正常不能证明无任何控制台错误。

### 逐项实际结果

| 检查 | 实际观察 | 结果 |
|---|---|---|
| 基准快照 | Spot BTC 0.4 / USDT 4000；Funding BTC 0.1 / USDT 1000；价格 50000 / 1 USD；来源 demo-spot/demo-funding、BINANCE/crypto/USD，时间 2026-10-13T00:00:00Z，fixture | 通过 |
| 独立手算风险 | Spot/Funding 24000/6000，合计 30000；BTC 5/6、账户 80%/20%；HHI 0.68 与 26/36；25000×20%+5000×10%=5500 | 通过 |
| 股票未覆盖 | unsupported，无股票快照，完整总资产始终不可用 | 通过 |
| 真实宿主写入/读回 | 两个账户保存并逐资产核对成功，读取 2 个账户/4 条持仓 | 通过 |
| 主程序分账户估值 | Spot 20000+4000=24000；Funding 5000+1000=6000 | 通过 |
| 重复写入 | 连续重复导入仍 2 个账户/4 条持仓；主程序 BTC 0.5 / USDT 5000，价值 25000+5000 | 通过 |
| 模拟划转及主程序重写 | BTC 0.3/0.2；主程序 Spot 15000+4000=19000、Funding 10000+1000=11000，合计仍 30000，插件压力 5500 | 通过；没有划转 API |
| 同步失败 | 两账户 failed，旧数量 0.3/0.2、4000/1000 保留，最近已知 30000，完整总资产不可用 | 数据保护通过；数字显示待修正 |
| 失败批次导入 | 提示「仅允许完整的模拟批次导入」，主程序保留成功划转快照 | 通过 |
| 缺价 | Spot BTC 0.4 保留并显示缺价格；有价格小计 10000，完整总资产不可用，压力仅已估值部分 1500 | 通过；不是完整敞口 |
| 缺价批次导入 | 提示「模拟资产或价格不受支持」；主程序 Funding 仍 BTC 0.2，未变为缺价样例的 0.1；Spot 仍 0.3，合计 30000 | 通过 |
| 恢复基准 | 再次同步及导入成功，恢复 24000/6000 | 通过 |
| 真正重启 | 关闭后窗口消失，重新启动 exe 并选择测试资料；安装 v0.1.1 保留，插件 30000/5500，主程序读回 2/4，持仓 BTC 25000 + USDT 5000 | 通过 |

### 遗留问题和验证边界

1. **真实接入前必须修正失败数字显示**：全部 failed 时，页面已覆盖小计/权重/压力仍为 0；虽然明确失效、不可用并保留最近已知 30000，仍易误读为资产/风险为零。本轮记录问题，未扩展开发。资产没有被清空。
2. 缺价后的最近已知小计可能变成 10000，它是已估值部分，不是最近一次完整估值；集中度/压力也仅对应有价格部分。
3. 模拟 averageCost=0，使主程序收益栏显示 25000/5000 等值，不能作为真实收益证据；这里只验收数量、估值、压力。
4. 主程序操作提示重开恢复「尚未执行主程序导入验收」，是临时页面文案，并非持久化历史；重新读取确认持仓仍在。
5. 跨账户中途故障、读回不一致、身份冲突、通用资产标识、CNY/USD 汇率、HMAC 仅离线或 SDK 替身测试；未在桌面人为制造数据库故障。桌面备份恢复、控制台、network/secrets、真实余额口径及 Stocks API 未验证。

结论：**不修改主程序的安装、模拟账户写入/读回、估值与风险路径可行**；整体验收不是无条件全通过。应先修正失败数字显示，再经用户确认开展真实只读同步。本轮停止，没有进入真实接入。

## v0.1.2 最小缺陷修复与复验（2026-10-13）

本次只修改风险结果的可用性与显示，没有修改宿主账户导入、批次替换、持久化格式、API/网络权限或主程序。根因是无有效数据时空集合求和为 0，之前 RiskReport 无法表达「当前估值不可用」。

### 修复后的数据契约

- 当前没有成功快照，或成功持仓全部缺价格/汇率：coveredSubtotal、stressLoss 返回 null，页面显示「不可用」，不再提供有效零风险。
- 成功查询的空持仓或有报价的零数量：小计与压力可为真实 0。零分母集中度不可用；不是风险消失的推断。
- 部分成功或部分缺价：只计算当前成功且可估值部分，标记 partial、成功账户数和无法估值条数；完整总资产仍不可用。失败持仓不参加当前风险。
- 保留快照单列 lastKnownSubtotal、快照时间集合、部分范围标记和历史失效说明。没有保留快照或全部无法估值时历史小计也为 null。历史金额不是当前实时资产或最近一次完整总资产的缓存。
- Stocks 继续 unsupported。原 30000 USD / 5500 USD 手算结果保持不变。schemaVersion=1，升级读取原模拟状态成功。

### 实际执行的自动化验证

`npm run verify` 全部通过：TypeScript 检查、**33 项测试 / 0 失败**、生产构建、ZIP 入口/清单检查、**6 种状态的实际编译入口静态渲染**、构建校验记录。原 25 项保留，新增 8 项覆盖无账户/无快照、首次全部失败、部分失败、成功空持仓/零数量、部分范围真实零、全部缺价/缺汇率、部分缺价、仅未支持及历史时间范围。

静态页面样例是无快照、失败且有历史、部分失败、部分缺价、真实零持仓、正常基准。它不是桌面证据。锁文件仅同步项目版本与脚本，不升级依赖；没有加入框架或服务。

安装包：`F:\Code\风控\artifacts\wealthfolio-binance-risk-0.1.2.zip`。

SHA256：`7a957cb3e43098b404b37bc804199f62d72b81a94c1e7b6bf85c88c8afb1c3a1`。原包和 BUILD-RECEIPT-0.1.1.json 保留。包内 README 为构建快照；当前 BUILD-RECEIPT 的 desktopInstallation 是打包时状态，桌面结果见本节及 WINDOWS-ACCEPTANCE-0.1.2.json。

### 真正执行的 Windows 复验

官方 Wealthfolio v3.9.1，原独立测试资料 **WRISK Windows 验收 20261013**。从文件升级 ZIP，用户亲自批准，确认网络权限保持关闭；管理器显示安装成功、版本 **v0.1.2**、仍为 1 个插件。没有修改权限清单，没有发起网络检测或 Binance 请求。

| 桌面检查 | 实际观察 | 结果 |
|---|---|---|
| 原状态升级恢复 | 成功打开，保留 30000 小计、5500 压力、24000/6000，Stocks unsupported，完整总资产不可用 | 通过 |
| 全部同步失败 | 当前小计、压力、集中度全为不可用，0/3 成功账户；历史 30000，时间 2026-10-13T00:00:00.000Z，数量保留并标注历史失效 | 通过 |
| 失败状态重启 | 真正关闭后窗口消失，重新启动 exe 并选择测试资料；失败状态、历史 30000、时间、不可用结果保持 | 通过 |
| 固定部分失败 JSON 恢复 | Spot failed、Funding ready；当前 6000 / 压力 1100，1/3 成功账户，partial，历史可估值部分 30000；旧 Spot 行当前权重不可用 | 通过 |
| 固定成功空快照恢复 | 2 个 ready 空账户，小计和压力为 0；Stocks 未支持，所以完整总资产仍不可用；权重不可用 | 通过 |
| 固定无快照恢复 | 小计/压力/历史金额不可用，时间无，uncovered / unsupported 与失效区分 | 通过 |
| 固定全部缺价恢复 | 2/3 成功快照，4 条无法估值持仓；数量保留、价格缺口可见，小计/压力/历史估值不可用 | 通过 |
| 模拟部分缺价按钮 | 一条缺价，10000 小计 / 1500 部分压力，partial，完整总资产不可用，缺价行无当前权重 | 通过 |
| 恢复正常基准与宿主读取 | 最后恢复 30000/5500；读取仍为 2 个主程序账户、4 条持仓 | 通过 |

恢复使用项目现有 JSON 恢复入口，四个完全固定模拟样例保存在 artifacts/V0.1.2-UI-FIXTURES.json；没有导出个人资料或读取数据库。JSON 恢复只更新插件模拟状态，没有将空持仓/部分样例写入主程序。

### 未执行与停止边界

缺汇率、有报价零数量、空账户列表及仅 Stocks 等额外边界由纯函数自动化验证，未逐一构造桌面页面。v0.1.2 没有重新执行宿主写入/划转完整验收，宿主逻辑未修改，沿用 v0.1.1 的实际证据并只读核对 2/4。控制台、桌面便携备份恢复、network/secrets、真实 Binance 口径及 Stocks API 仍未验证。

结论：本次不可用与零资产混淆缺陷已修复，自动化、构建/打包和上述真实桌面复验通过。安全边界不变；本轮停止，不进入真实 Binance 开发。

## v0.1.3 真实接入前安全整改（2026-10-14）

实际修改：src/credentials.ts（新增）、src/backup.ts（新增）、src/domain.ts、src/binance.ts、src/fixtures.ts、src/host.ts（备份实现转为新模块重导出）、src/addon.tsx；tests/security.test.ts（新增）、tests/binance.test.ts（明确离线/fixture 名称）、scripts/smoke-package.mjs；package.json、package-lock.json、manifest.json；README、AGENTS、CURRENT、ARCHITECTURE、VALIDATION、SECURITY（新增）、WINDOWS-ACCEPTANCE。没有修改主程序、上游或旧 WorldState，没有 Git 提交、PR 或上传。

### 自动化与打包

完整 `npm run verify` 通过：类型、**46 项测试，0 失败**、构建、ZIP 清单/入口、6 种编译页面显示、校验记录。新增 13 项安全测试包含候选/读回/切换失败（包括写后报错）、删除重试、重建控制器、秘密命名空间、外部来源/去重/时效、Funding 原始字段、跨钱包阻断、递归白名单/恶意恢复/正常历史 v1、模拟故障服务器的日志负对照。原 30000 USD / 5500 USD 基准不回归。

SDK 替身故障验证不是 Windows 原生凭据库故障注入。模拟网络负对照运行临时 Node HTTP 服务和宿主 invoke / reqwest 风格错误替身，复现插件脱敏发生在宿主记日志之后的问题；没有运行官方 Rust 网络链路，也不是插件 localhost 代理。阻断门不调用 mock broker；完整官方日志安全未通过，参见 SECURITY 源码链路。

安装包：`F:\Code\风控\artifacts\wealthfolio-binance-risk-0.1.3.zip`。

SHA256：`801b27e64f2876bbcab33562bf3599b0b689eda32c82cb5bc431155db18703dc`。旧包/构建记录保留。后续验收文档更新没有重打包，包内文档是构建快照。没有依赖升级。

### Windows 真实执行

官方 v3.9.1，独立资料 WRISK Windows 验收 20261013；用户亲自批准 v0.1.3，安装列表显示版本 0.1.3。权限预览只有 Secrets Management（set/get/delete）与 File Operations（openSaveDialog），没有 network、secrets.use、账户、持仓、快照或报价权限。

| 检查 | 实际结果 |
|---|---|
| 升级/旧模拟状态 | 成功打开，30000 小计 / 5500 压力，Stocks unsupported；旧 fixture 格式正常恢复 |
| 初始安全存储 | 官方 secrets 读回 null |
| 保存假凭据 v1 | 写入并完整读回核对成功，不显示内容，保持断开 |
| 真正重启读回 | 关闭客户端至窗口消失，重新启动并选测试资料；官方 secrets 再读回 v1，模拟风险仍 30000/5500 |
| 替换假凭据 v2 | 候选槽保存、读回、切换成功并核对 v2 |
| 断开并删除 | 用户亲自点击；界面确认所有槽位删除并读回 null；随后助手再次独立读回 null |
| 当前宿主日志 | 保存 v1 后关闭客户端，扫描当前 LocalAppData 日志文件 11113 字节，没有 WRISK_FAKE_KEY_ / WRISK_FAKE_SECRET_ 标记；未输出日志内容 |
| 替换/删除后的日志 | 应用运行期间普通读取被文件锁拒绝；随后只读共享打开成功，扫描 18854 字节，仍无上述假标记，未输出原始日志。最后窗口被最小化，未继续调整用户桌面 |
| AI 只读检查 | 当前资料 OpenAI 兼容 Provider 启用、含 DeepSeek 模型；九项数据访问勾选，账户含现金、持仓含净资产；不满足真实测试隔离；未修改配置、揭示密钥或发消息 |

凭据只通过官方 secrets；页面不接收真实输入，普通 storage 只保存清洗后的模拟业务字段。日志扫描只能证明已观察的成功保存日志没有这组假标记，不能证明所有原生失败错误安全或签名日志已解决。

### 未执行、阻塞与审查条件

- 原生 OS 写入故障/回滚故障、他插件越权尝试未在 Windows 制造；对应路径通过 SDK 替身和上游命名空间源码核查。旧槽保留不等于跨键事务，在系统同时拒绝回滚时活动状态不能保证，但认证始终关闭。
- 新白名单备份/恶意恢复只做自动化和编译入口测试，未在 Windows 实际导出/恢复文件；正常旧状态升级已实测。未重复旧宿主写入，本版已撤下权限。
- external 时效/Funding/跨钱包仅脱敏自动化验证，没有真实采集；资金总量和内部划转一致性仍阻塞。当前默认 TTL 不是生产参数承诺。
- 官方签名请求网络故障及原始日志链路未实测解决；源码表明存在风险，认证发送硬阻断。没有真实密钥或 Binance 请求。
- AI 配置保存/关闭后的拒绝读工具、跨资料库开关独立性与历史上下文不会外传未实测；方案/源码和当前配置检查已记录，不改变用户设置/聊天。无全局 AI 变更。
- Stocks 完整只读证券持仓/现金 API 仍未确认。

已完成可控基础整改，具备交 Astra 下一轮安全复审的条件；**不具备连接真实 Binance 的条件**。下一步唯一建议为复审源码和未解决阻塞，再决定是否批准官方代理假请求与 AI 拒绝工具验证。本轮立即停止。

## v0.1.4：Spot 优先离线链路（2026-10-14）

### 实际执行与结果

本机 Node 24.17.0，完整 npm run verify：**65 项自动化测试，0 失败**；类型、构建、ZIP 与 6 种编译入口旧风险显示全部通过。新增 19 项 Spot 测试。后续仅 README 更新后再次执行 package/smoke/receipt，源码和已通过测试未改；最终包校验如下。

| 验证 | 结果 / 边界 |
|---|---|
| time→account→ticker→标准化→风险 | 固定假凭据、模拟响应全流程通过；0.4 BTC + 4000 USDT，BTCUSDT=50000，24000 USDT / BTC -20% 损失 4000 USDT |
| 旧模拟手算 | 30000 USD / 5500 USD 保持；USD 基准与新 USDT 会话不相加 |
| 服务器时钟 | 中点校准；慢 RTT、倒退、无效/微秒响应、偏移过大拒绝；签名与 Node 独立 HMAC 比较通过 |
| 401/403/429、-1022/-1021、超时 | 固定错误分类，失败保留数量但当前 null；429 冷却无自动重试；实际定时器超时中止 mock signal |
| 重复 / 换假 Key / UID 改变 | 同 UID 只有一份替换快照；不同 UID 拒绝，旧来源不清零 |
| 缺价 / 错 symbol / 零或非法价格 | 数量保留，无旧报价回填，缺口明确，不捏造零；未知资产缺价/unknown |
| 成功空余额 / 首次失败 | 成功空为 0；首次失败当前和历史不可用 |
| 过期/未来余额、价格、缺 FX | 新 fixture 链路也执行 TTL；过期余额当前不可用、历史保留；USDT 不默认转换 USD |
| 取消 / 并发 | 并发拒绝、断开拒绝新请求及在途成功；UI 删除前断开，凭据只通过原官方 secrets |
| 来源 / 额外字段 | fixture/external 身份不同；external 无模拟报价/成本；额外字段和认证信息不进入状态；新 Spot 不导出到旧备份 |
| 权限 / 生产网络 | 编译包没有 direct fetch、network.request、浏览器存储或宿主写入；仅 secrets set/get/delete 与 files.openSaveDialog；真实发送门继续阻断 |
| 官方日志链路 | 重新读取 tag v3.9.1 network.rs:103/121、tauri/core.ts:55；风险仍存在。原模拟故障服务器负对照通过，不是官方 Windows 日志保护通过 |
| Windows v0.1.4 | **未安装、未交互复验**。没有操作客户端或已安装 v0.1.3 测试资料库 |
| 真实 Binance / AI | 无真实凭据、无公开/私人 API 请求、未开启网络、未改 DeepSeek/Provider/聊天 |

### 产物与版本

新包 artifacts/wealthfolio-binance-risk-0.1.4.zip；
SHA256 **fb5fc4690ee041a7596a4c58141a0834ec7fbf4e84512982f4e53159de940df6**。
旧 v0.1.3 ZIP 原样保留，SHA256 801b27e64f2876bbcab33562bf3599b0b689eda32c82cb5bc431155db18703dc。

GitHub Private 仓库已创建并核查：
https://github.com/631231771-cmd/wealthfolio-binance-risk。
main/v0.1.3 保存基线提交 91f3432；本轮 feature/spot-readonly-offline 独立开发，不自动合入 main。
只提交源码、测试、已清洗文档、锁文件和配置；没有上传真实/模拟运行时账户资料、DB、日志、ZIP、node_modules、提示词文件或凭据。源码中固定公开假值是明确审核的测试向量。版本号和依赖锁保持一致，依赖版本未升级。

### 修改文件与剩余条件

新增 src/spot.ts、src/spot-fixture.ts、tests/spot.test.ts、docs/REVIEW-PACKET.md、docs/GIT-WORKFLOW.md 和 .github/workflows/verify.yml；调整 src/addon.tsx、src/domain.ts、scripts/smoke-package.mjs、manifest、package/lock 与 README/AGENTS/CURRENT/ARCHITECTURE/API-VERIFICATION/SECURITY/WINDOWS-ACCEPTANCE/VALIDATION。基线先补充 .gitignore 后提交。没有修改 credentials/binance/backup/host 的历史实现或宿主代码。

审查材料 70 行以内，增量 artifacts/v0.1.3-to-v0.1.4.patch 只给相关代码，不包含整套上游/文档。Git 提交、当前 HEAD 与远端同步以 git log、ls-remote 为准；GitHub Actions 结果独立记录，不能把本地通过当成远端 CI 已通过。

真实 Spot 仍阻塞：官方日志保护/假请求全链路、外部 AI 拒绝工具实测、真实凭据错误路径与只读权限、分类/价格时效与对账/备份边界。Funding/Stocks 未接入，单 Spot 不冒充全账号。下一步仅交 Astra 增量复审，由用户决定后续验收授权。

## v0.1.5 多币 Spot 离线估值（2026-10-14）

- 用户已撤下本轮桌面验收前置条件，要求只推进非桌面开发；没有调用 Windows 桌面工具。v0.1.4/v0.1.5 实际安装与交互均待办，不宣称通过。
- 本机完整 npm run verify 通过：**74 项测试，0 失败**；类型/构建/ZIP，6 个旧状态及 3 个多币列表编译渲染。新增 9 项行情/多币测试；现有 65 项保留，只调整公开元数据的 mock 契约。
- 六币种独立手算：BTC 20000、ETH 5000、BNB 5000、SOL 3000、DOGE 100、USDT 4000，共 37100 USDT；非 USDT 回落 20% 损失 6620；BTC 占比 0.539084，HHI=475010000/1376410000≈0.345108。
- 缺 ETH 报价及无市场 NOPAIR 7：数量保留，32100/5620 仅已定价部分，完整总额 null、2 条缺估值。过期/未来价格不计当前估值；全部过期小计/压力 null，历史仍 37100。
- exchangeInfo 用明确 baseAsset/quoteAsset/TRADING/Spot allowed；暂停、非 Spot、非 USDT、歧义映射不用，不能猜 symbol。额外/重复/非法价格响应拒绝，缺 ticker 行留缺价；unknown 法律类型不变。
- 单币/批量 ticker GET 构造无 header/body/签名，最多 100 symbols/批。101 币后批失败保留全部数量，仅计算首批成功范围，不继续请求或伪造完整值。全部通过 mock，没有访问 Binance。
- 正常零资产、认证故障、限流、断开/在途、重复和 UID 去重由原测试持续覆盖。原 30000 USD/5500 USD 与 24000 USDT/4000 USDT 不回归；USD 缺 FX 仍不可用。
- 列表列出数量、报价/来源/采集时间、市值、百分比、逐币损失、余额起止与当前/历史状态；失效不显示有效占比。新会话不与旧资产相加，旧备份不扩展。
- 包 artifacts/wealthfolio-binance-risk-0.1.5.zip；最终 SHA256 **7fba58261c0fe684f21d353afea8314120beeaf3f0548001585731ab2127554b**。README 更新后仅重打包/记录；所有旧 ZIP 原样保留。
- 修改：src/spot-quotes.ts（新增）、spot.ts、spot-fixture.ts、addon.tsx；tests/spot-quotes.test.ts（新增）、spot.test.ts、scripts/smoke-package.mjs；版本/清单及 README/AGENTS/CURRENT/ARCHITECTURE/GIT-WORKFLOW/VALIDATION。没有重构通用风险/凭据/备份，依赖未升级。
- 推送仍是既有 Private 的 feature/spot-readonly-offline，main 不变；提交/Actions 以 Git 和 artifacts/CI-RECEIPT-0.1.5.json 为准，本地通过不冒充 CI 或真实客户端。
- 网络权限未新增，真实发送阻断未改，无真实 Key、私人账户、DeepSeek 变更或 Astra 审计。签名日志/AI 隔离/真实只读权限/真实报价对账和备份仍待验收。公开接口尚无实际连通验证，需用户另行授权。
