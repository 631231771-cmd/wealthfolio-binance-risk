# v0.1.6 公开行情实现与权限边界

2026-10-15；基线 v0.1.5/f07cf33，Wealthfolio 3.9.1 / SDK 3.9.0。用户已明确授权公开联网，并亲自批准唯一主机；本方案已实施。实机结果见 [VALIDATION](VALIDATION.md) 最新节。

## 官方接口与实现

- [专用行情主机](https://github.com/binance/binance-spot-api-docs/blob/master/faqs/market_data_only.md)：`https://data-api.binance.vision` 无需身份认证。
- [time / exchangeInfo](https://developers.binance.com/en/docs/catalog/core-trading-spot-trading/api/rest-api/general)：GET；前者仅显示服务器时间参考，后者验证 symbol/baseAsset/quoteAsset/status/isSpotTradingAllowed。exchangeInfo 固定请求 BTCUSDT、ETHUSDT、BNBUSDT、SOLUSDT、DOGEUSDT，避免全市场响应超过宿主 2MiB 限制。
- [ticker/price](https://developers.binance.com/en/docs/catalog/core-trading-spot-trading/api/rest-api/market)：GET，symbol/symbols 互斥，symbols 为编码后的 JSON 数组；没有成交时间。本插件只展示本机采集时间，不承诺上游最后成交发生时刻。
- PublicMarketReader 仅接收 network.request 方法，不接收 secrets、整个 ctx 或离线认证传输。请求只有 url、method=GET、timeoutSecs；不接受任意 URL、header、body、auth 或附加认证参数。
- 固定模拟数量 × external 来源报价；Snapshot 仍为 fixture。USDT=1 USDT 是同币单位，不建立 USD 汇率。结果只在页面内存，既不写宿主，也不进入旧模拟备份。

## 权限由谁限制

新增 network.request，清单 allowedHosts 只有 `data-api.binance.vision`，没有通配项；approvedHosts 由用户通过官方权限页批准。

- [宿主 service.rs](https://github.com/wealthfolio/wealthfolio/blob/v3.9.1/crates/core/src/addons/service.rs)：安装/更新审批与申请主机取交集，执行请求使用 approved_hosts。
- [宿主 network.rs](https://github.com/wealthfolio/wealthfolio/blob/v3.9.1/crates/core/src/addons/network.rs)：HTTPS、精确主机匹配（本清单不使用通配符）、禁止 URL 凭据、阻止私网目标、禁止重定向。**宿主没有按本插件的三条路径/GET/默认端口实施授权白名单**；这些更窄约束来自插件固定构造，不能将其说成宿主沙箱能力。
- [Tauri 命令](https://github.com/wealthfolio/wealthfolio/blob/v3.9.1/apps/tauri/src/commands/addon_network.rs)与上述源码：无 auth 的公开请求不解析安全存储凭据。保留的 secrets.set/get/delete 仅用于旧假凭据验收，无 secrets.use。

已核查源码与真实审批界面，没有对未授权主机/私人路径进行实际负向网络探测。自动化断言所有构造字段、唯一主机及无凭据能力；没有做 TLS 抓包，因此不把源码/契约检查表述为抓包证明。

## 失败与剩余边界

响应必须为成功状态、有限长度合法 JSON 和可靠正数报价。缺行保留数量、不沿用旧价格；失败、断开或 120 秒过期时当前不可用，历史单列。429/418 依 Retry-After 冷却（无有效值时 60 秒），不自动重试。

SDK 没有取消 API：宿主请求超时为 10 秒，页面等待上限 15 秒；页面超时后仍等待底层 promise 结束才可再发，断开后迟到结果不发布。DNS 等宿主实现限制不能靠前端取消消除。模拟断网按钮只注入失败状态，不修改 OS 网络；HTTP/超时故障主要由 mock 验证，不能当作原生故障通过。

签名 URL 错误日志保护仍无已验证的官方插件解决方案：底层请求错误字符串及宿主 invoke 日志不受插件捕获控制。专用公开主机仅避开认证请求，不解决这个阻塞；真实认证继续硬阻断。首次真实 Spot 还须解决该链路、逐资料库禁用外部 AI/清空工具许可、凭据及只读权限验收、资产身份/价格/余额对账与备份边界，再由用户单独授权。Funding/Stocks 未支持。
