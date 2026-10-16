# 首次Spot连接复核与交付（2026-10-16）

本轮目标：本人保存凭据后，一次确认读取Spot币种和数量。当前主机3.10.0；起点HEAD621812a及所有未提交0.1.12/0.1.13改动原样保留后增量修改。没有读取本机凭据、UID、真实响应/持仓或日志，没有助手认证查询、桌面观察、提交或推送。

## 独立判断

| 环节 | 判断 | 处置 |
| --- | --- | --- |
| HMAC与GET参数 | 与参考插件及官方一致，未证实签名算法错误 | 保留；测试用Node crypto独立验证实际构造的签名 |
| 三样本校时 | 已有合格样本仍被随后宿主拒绝推翻，源码和虚构复现确定；与本人最新脱敏回报相符 | 改同一Spot主机、首个合格即继续，最多3次有限重试 |
| 行情前置 | 收到可靠余额仍等待另一主机time/exchangeInfo/ticker，增加延迟和断开窗口 | 余额独立发布；行情按钮另行触发 |
| 余额UTF-8 | 旧ASCII限制与官方冲突；v0.1.13已有修复 | 保留并用虚构Unicode余额到实际面板渲染复验；不能据此断言旧SPOT_INVALID的真实字段 |
| 权限与UID | 官方apiRestrictions有当前必查字段；账户canTrade不是API Key交易权限证明 | 保留权限先于余额、UID匹配、ipRestrict允许false但必须布尔、未知true拒绝 |
| 官方SDK | response.body为文本；HTTPS精确主机、禁止重定向、HTTP超时不含前置DNS；没有取消能力 | 保留官方代理；无TLS、代理、Windows安全设置变更 |
| 原生网络失败 | 旧HOST_REQUEST_FAILED只有宿主字符串，不能反推出DNS/TLS/超时 | 保留固定层级与数字；不继续猜测或索要原始日志 |
| 本机签名日志 | 3.10.0仍有完整URL异常到持久日志的路径 | 用户本轮再次接受；未宣称修复宿主，也未扩大为Key/Secret/资产上传授权 |

参考项目仅供对照，没有复制代码或新增依赖。其缺字段回退空数组、过滤不合格行、LD前缀改写、输出原始错误正文均不采用。保留现有UI、风险纯函数、备用本地读取器、fixture备份边界。

## 最短实际路径

本人确认→官方secrets读回→GET api.binance.com/api/v3/time→GET apiRestrictions→GET account→严格解析→UID核对→单批替换→现有持仓列表。

- time第一个合格样本即采用；保留2000ms RTT、60000ms偏移、250ms墙钟差及recvWindow=5000。慢样本、已完成宿主调用拒绝、HTTP5xx网络错误最多共3次；无效字段/时钟跳变/过大偏移、429/418、在途超时、隐藏/断开立即停止。
- 每个签名请求发送前取当前校正时间；只有固定GET权限/余额路径。不用omitZeroBalances隐藏坏零行，不变更资产名称、数量口径或账户类型。
- 只保存一份会话快照，free+locked十进制相加；缺价数量保留。空余额必须来自有效成功响应；失败不是零。
- 首次及5分钟自动刷新只读余额；公开估值另行请求。公开请求在途未结束也阻止余额重叠，断开/隐藏不继续后续公开请求，晚到限流保留。

## 证据边界

本轮新虚构用例在修复前失败，修复后通过：候选凭据保存后重新构建管理器读回→校时故障→独立HMAC验证→只读权限→UID/Unicode余额→真正DirectSpotPanel渲染。另覆盖行情失败不撤销余额、UID不符/缺余额拒绝、行情超时与晚到限流。所有值固定虚构且transport替身，**不是实际Windows/SDK/币安认证验收**。

完整verify结果与包哈希见VALIDATION最新节。没有本人的真实持仓成功反馈前，只能称“软件修复完成、等待本人验收”。当前无法把此前全部失败归为同一个原因。

## 本人一次验收

后续用户回报：本人已通过v0.1.14读取9项真实Spot持仓，数量逐项核对一致。仅记录验收结论；估值、自动刷新和后续稳定性仍待验证。

1. 安装唯一0.1.14 ZIP；管理器确认版本，页面应有“更新公开估值”。不删除重建资料库，不必重填已保存凭据。
2. 本人核对独立小额UID、API纯只读、测试资料库AI隔离及日志风险。凭据只在本机输入；期间助手不观察桌面。
3. 本人点击首次查询一次，自动保持关闭，不点行情。通过标准：成功状态、UID校验通过、币种/数量与Binance Spot逐项一致；零余额只能在本人确认确实为空时通过。
4. 聊天只回复“余额读取成功/失败、本人对账通过/未通过”，失败附页面固定阶段/安全码/HTTP/校验层级-路径-原因及公开校时摘要。不回传UID、币种、数量、原始响应或日志。
5. 若仍是HOST_REQUEST_FAILED，只能判定宿主调用链失败，不能确认是宿主缺陷、网络或交易所；若HTTP200/JSON有效且固定字段拒绝，则证据指向解析边界。此时按现有摘要判断，不盲目安装下一版。

## 官方和参考来源

- [Binance GET account](https://developers.binance.com/en/docs/catalog/core-trading-spot-trading/api/rest-api/account)：uid为int64，accountType、balances/asset/free/locked；当前安全整数范围外拒绝而非失精接纳。
- [Binance REST通则](https://developers.binance.com/en/docs/products/spot/rest-api)：GET参数必须query、HMAC-SHA256、UTF-8资产名与时间窗口。
- [Binance API权限](https://developers.binance.com/en/docs/catalog/core-trading-wallet/api/rest-api/account)：apiRestrictions及各布尔字段。
- [参考插件固定提交](https://github.com/jimmylin0979/crypto-wealthfolio-addon/blob/82a56aa8bc92975b3d91e33f746ac19746418ba0/src/lib/exchanges/binance.ts)：签名构造与当前实现一致，无替换算法依据。
- [宿主3.10.0 Rust代理](https://github.com/wealthfolio/wealthfolio/blob/f9643209e7cafcaf133d5a8fbe1ef2fa4fd7fc04/crates/core/src/addons/network.rs#L103)：send和chunk在103/121行直接e.to_string()。
- [宿主3.10.0 invoke](https://github.com/wealthfolio/wealthfolio/blob/f9643209e7cafcaf133d5a8fbe1ef2fa4fd7fc04/apps/frontend/src/adapters/tauri/core.ts#L50)：在交回插件前logger.error原异常；15行调用Tauri plugin-log。
- [reqwest Error](https://docs.rs/reqwest/latest/reqwest/struct.Error.html)：错误可含完整URL，without_url需宿主侧处理。它不等于Secret或API Key被这一行输出；Secret用于本地HMAC、Key在header、signature在query，风险不可混同。
