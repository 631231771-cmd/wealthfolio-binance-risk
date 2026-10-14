# Binance 官方接口验证记录

日期：2026-10-13；没有真实 API 密钥、没有私人账户请求。本阶段只做文档/固定响应/离线签名验证。

| 产品/接口 | 权限/签名 | 已验证 | 未验证 |
|---|---|---|---|
| Spot `GET /api/v3/account` | USER_DATA，X-MBX-APIKEY + timestamp/recvWindow + 签名 | 官方接口存在，free/locked 固定响应解析，错误响应拒绝，HMAC/请求序列化 | 真实读取权限、实际持仓与账户对账 |
| Funding `POST /sapi/v1/asset/get-funding-asset` | USER_DATA 签名；POST 是查询，不是划转 | 官方接口存在，四个余额桶保留，固定响应解析与签名请求构造 | 四桶是否互斥/总量口径、权限、真实划转时一致性 |
| Stocks 当前真实证券持仓/现金 | 没有已确认完整接口 | 股票 REST 文档含行情、订单、成交、代币转换及监听密钥；Account 页仅免责声明 | **完整只读持仓+现金快照、分页和权限未确认**，保持 unsupported |
| bStocks | 与真实证券不同的代币化证券 | 官方 FAQ 区分法律结构；不直接等于底层股票，不混合资产身份 | 实际账户位置、余额、乘数与估值均未实现 |
| 公开时间 `GET /api/v3/time` | 无密钥 | 页面提供经宿主代理探测按钮；请求地址固定 | 官方桌面网络代理实际连通未测 |

## 官方来源

- [Spot 账户信息](https://github.com/binance/binance-spot-api-docs/blob/master/rest-api.md#account-information-user_data)
- [端点安全](https://developers.binance.com/en/docs/catalog/core-trading-spot-trading/api/rest-api/endpoint-security-type)
- [Funding Wallet](https://developers.binance.com/en/docs/catalog/core-trading-wallet/api/rest-api/asset#funding-wallet-user_data)
- [Stocks Account](https://developers.binance.com/en/docs/catalog/advanced-trading-stocks-trading/api/rest-api/account)
- [Stocks Market Data](https://developers.binance.com/en/docs/catalog/advanced-trading-stocks-trading/api/rest-api/market-data)
- [Stocks API 公告](https://www.binance.com/en/support/announcement/detail/95d746cb2b5e4d179c50d0026dd7dfbe)
- [bStocks FAQ](https://www.binance.com/en/support/faq/detail/f0c03cd6509a4085b4cce1636f16be38)
- [官方签名固定样例](https://github.com/binance/binance-signature-examples)：测试只使用公开 dummy secret 和 `timestamp=1578963600000` 样例；不复制其生产代码，不发送交易请求。

## 验证结论与安全

`buildReadRequest` 只能构造两个余额查询接口。没有私人请求发送器、API 密钥输入、提现/交易/划转代码。HMAC 比对官方固定输出、RFC4231 向量和 Node 独立实现；这是算法与序列化正确性证据，不是交易所权限或接受请求的证据。

模拟 Funding 数量按四桶相加，明确只是测试口径；真实接入前必须核实 freeze/withdrawing 与其他桶是否重叠。缺字段、错误响应抛错，绝不改成空资产。未知资产仍保留符号/数量，缺价格不能虚构估值。

真实股票接口未确认不代表币安没有股票 API，而是现有证据不足以建立可靠快照。订单与成交历史、旧 Stock Token 描述、现货余额、监听密钥不能代替当前真实证券持仓。
