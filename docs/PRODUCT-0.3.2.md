# v0.3.2 汇率读取修复与成本口径

## 一、`USDT → 基础货币：不可用` 的根因

**宿主限制，不是插件缺少汇率。**

Wealthfolio v3.10.0 `crates/core/src/fx/fx_service.rs`：

```rust
fn get_exchange_rate_for_date(&self, from_currency: &str, to_currency: &str, date: NaiveDate) -> Result<Decimal> {
    if from_currency.len() != 3 || !from_currency.chars().all(|c| c.is_alphabetic()) {
        return Err(FxError::InvalidCurrencyCode(...));
    }
    ...
}
```

- 按日期的汇率接口**只接受 3 位字母代码**；`USDT` 长度为 4，直接返回 `InvalidCurrencyCode`，根本不会查询已存在的手动汇率。
- 批量接口 `get_exchange_rates_for_dates` 对每一对返回 `{ rate: null, error }`，不抛整批错误。
- 插件旧实现只读 `row.rate`，把 `null` 当成"没有汇率"，于是显示"不可用"并阻断写入。
- 手动汇率本身是有效的：`exchangeRates.getAll()` 会返回 `USDT → USD, 1.0, MANUAL`。

**修复**：汇率解析改为两级——先按日期查（适合 3 位法币），失败则回退到 `getAll()` 的最新记录（支持 4 位代码），并支持反向汇率取倒数。绝不默认 1。

## 二、只读诊断

原生同步页现在区分：

| 状态 | 含义 |
|---|---|
| 有效 | 拿到正数汇率（按日期 / 最新记录 / 反向） |
| 有效（记录较旧） | 汇率可用，但记录超过 7 天 |
| 未找到记录 | 两条路径都没有该货币对 |
| 记录无法解析 | 记录存在，rate 不是正数 |
| 权限不足 | 宿主拒绝 `currency` 权限 |
| 接口不可用 | 其他宿主调用失败 |

只显示状态、来源、日期和数值，不读取其他财务数据。

## 三、成本缺失的最终结论

宿主 `ManualHoldingInput.average_cost` 是必填 `Decimal`，缺失 `averageCost` 会被当作 0；`unrealized_gain = market_value − cost_basis`，因此**未知成本会显示为全部市值都是收益**。宿主没有"成本未知"的表示。

因此：

- **正式资料库保持缺成本阻断**；生产包不再提供"仅导入数量"的放行开关（smoke 会检查包内不存在该文案）。
- `NativeOptions.allowUnknownCost` 只保留给虚构测试与预览，用来验证不完整成本场景，不作为产品路径。
- 不写虚假成本、不修改宿主数据库、不用提示文案代替数据隔离。
- 记录为宿主限制，等待未来版本支持"未知成本"。

## 四、顺带修复的两个真实缺陷

1. **负收益导致整页崩溃**：Hero 与成本表用 `nonnegative()` 解析带负号的盈亏字符串，负收益会抛 `数量或价格格式无效`，React 整页空白。已改为数值解析 + 绝对值格式化，涨红跌绿。
2. **USDT 现金被当成缺成本**：成本表把 USDT 当作普通持仓，导致账户盈亏永远"部分覆盖"。现按宿主口径把 USDT 现金按面值 1 计入成本、盈亏恒 0；只有证券成本存在时才声明"已核实"。

## 五、残余风险

1. 宿主读取时若汇率消失，`get_fx_rate_or_fallback` 仍会静默按 1.0 计算；插件只能在写入前阻断，无法控制读取。
2. 原生报价没有 TTL，不同步就不更新。
3. 报价按资产全局写入，可能影响其他账户中同一资产的估值。
4. 首次导入前无法 `checkImport`（需要已存在账户）。
5. `Holding.quantity` 是浮点，读回对账使用 1e-12 相对容差。

## 六、权限

`currency` 增加 `getAll`（只读汇率列表）。其余权限不变：`accounts(getAll,create)`、`snapshots(getAll,getByDate,checkImport,save)`、`quotes(update)`、`settings(get)`、`secrets`、`network`、`files`。未申请删除、组合重算、活动或市场数据同步。
