# v0.3.0 原生账户同步与成本基础

## 结论与证据边界

本轮把 Binance Spot 持仓接入 Wealthfolio 原生账户（CRYPTOCURRENCY · HOLDINGS），并提供成本基础与 FIFO 原型。
**原生写入只在虚构宿主与合成数据上验证过，未对任何真实资料库执行。** 真实写入必须由本人按第九节步骤确认。

依据：`@wealthfolio/addon-sdk@3.9.0` 类型定义（目标宿主 3.10.0）与 Wealthfolio v3.10.0 源码
`crates/core/src/portfolio/snapshot/manual_snapshot_service.rs`、`crates/core/src/assets/assets_service.rs`、
`holdings_import_validation.rs`。未把 main 分支的新行为当作 3.10.0 已支持。

## 原生 API 结论

| 问题 | 结论 |
|---|---|
| 能否创建加密账户 | 能。`accounts.create({name, accountType:'CRYPTOCURRENCY', currency:'USDT', trackingMode:'HOLDINGS'})` |
| 能否写入持仓 | 能。`snapshots.save(accountId, SnapshotHoldingInput[], cashBalances, date)` |
| 追踪模式 | HOLDINGS：快照即账本，`source != Calculated` 才会被读取 |
| 资产身份 | `instrumentType:'CRYPTO'` + `quoteCcy` 生成 `CRYPTO:SYMBOL/QUOTE`；同身份自动复用已有资产 |
| 去重 | 传入 `metadata` 时按 instrument_key 去重；随机 assetId 只影响首次创建，不会重复建资产 |
| 成本 | `averageCost` 写入 Position.total_cost_basis；MANUAL 模式还会用成本生成一条报价，因此本插件不设 MANUAL |
| 现金 | USDT 作为 `cashBalances`，不作为需要报价的持仓 |
| 计价 | 账户币种 USDT；报价币种 USDT；不做 USDT=USD 假设 |
| 汇率 | `exchangeRates.getRatesForDates` 只读探测 USDT→基础货币；缺失时**阻止写入** |
| 重复同步 | 快照按账户+日期 upsert；同日重复写入覆盖当日，不累加 |

## 实现

- `src/native-sync.ts`：纯映射。USDT→现金；其余资产 `CRYPTO/USDT`；零数量、非法代码不写入；成本只写已知值；账户绑定用 UID 的不可逆 16 位哈希；写入指纹只覆盖账户、日期、数量、成本、现金（报价变化不会让预览失效）。
- `src/native-host.ts`：宿主适配。`probe`（账户、基础货币、汇率）→ `preview`（映射、已绑定判断、`checkImport` 预检）→ `apply`（二次指纹校验、创建/绑定、写快照、读回对账、推送报价）。
- `src/native-panel.tsx`：第三页签「原生同步」。能力检测、成本录入、导入预览、勾选确认、写入结果。无自动写入。
- `src/cost-basis.ts`：手动单位成本 + 部分覆盖盈亏。分母是已核实成本；未知成本不按零。
- `src/trade-cost.ts`：`myTrades` FIFO 原型。覆盖买/卖/手续费/第三币手续费/超卖/空历史/余额不匹配；不发请求。
- 顶部 Hero 增加成本口径：未录入→「成本尚未核实」；部分→「仅已核实成本部分」；完整→「持仓累计盈亏」。涨红跌绿。

## 权限

新增并显式声明：`accounts(getAll,create)`、`snapshots(getAll,getByDate,checkImport,save)`、`quotes(update)`、`currency(getRatesForDates)`、`settings(get)`。
未申请 `snapshots.delete`、`portfolio.*`、`activities.*`、`market-data.*`。主机白名单不变。

## 未完成 / 需要本人确认

1. **真实资料库写入未执行**。需要本人在独立测试资料库中安装 0.3.0，先「检测宿主能力」，再「生成导入预览」，核对后勾选写入。
2. 首次导入前无法调用 `checkImport`（该接口需要已存在的账户），因此首次的符号预检由宿主在写入时完成；第二次起可预检。
3. 原生仪表盘能否把 USDT 换算为基础货币取决于宿主已有汇率；缺失时插件阻止写入，不伪造。
4. 成本仅保存在本次会话；长期成本应由原生 `averageCost` 承载。插件不建立第二套持久账本。
5. `myTrades` 自动成本仅完成设计与合成测试，正式启用需单独授权。

## 已知限制

- 只覆盖直接 USDT 市场；无反向/多跳换算。
- 报价写入使用 `Quote.close`（number），超过 2^53 的精度不适用；加密价格范围内无实际影响。
- 读回对账使用宿主 `Holding.quantity`（number），按 1e-12 相对容差比较。
- 历史模拟账户（WRISK）不被读取、修改或合并。
