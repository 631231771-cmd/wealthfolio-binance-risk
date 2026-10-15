# 独立小额Spot直接只读验收

v0.1.10，当前宿主3.10.0；真实验收结果以VALIDATION末节为准。本地读取器仅备用。

## 本人操作的三个关口

1. 在WRISK独立测试资料库导入0.1.10 ZIP。宿主权限仍只有secrets.set/get/delete、files.openSaveDialog、network.request；主机是data-api.binance.vision、api.binance.com。本人批准两个精确主机并保存，必要时重启宿主。宿主只限制主机，不限制路径；本项目固定GET白名单，没有账本读写权限。
2. 本人在币安官方API管理创建/检查独立几千元测试账户的HMAC只读Key，核对UID与IP限制。禁用交易、提现、内部/通用划转、杠杆/合约/期权等。只填本机插件密码框，点击“仅保存本机只读凭据”；保存后密码框必须清空。**期间助手停止桌面观察；不要发Key、Secret、UID、权限截图或账户文件到聊天。**
3. 本人核对测试资料库的外部AI Provider禁用、账户/持仓/现金工具未授权，不沿用旧聊天/附件；不改其他资料库或全局DeepSeek。本人接受“签名URL可能进入本机宿主错误日志”的剩余风险，勾选四项确认并亲自点击首次查询。该确认不允许Key/Secret泄露、日志上传或放宽SSL/只读限制。首次会发送签名权限查询（这本身需要确认），只有权限检查通过才发余额查询。

若AI权限只能全局改变，先停止并由用户决定；不能假设独立资料库自动隔离。本插件没有控制Provider权限的能力；不通过聊天或AI工具分析真实资产。

## 对账和自动刷新

- 无需EXE/复制JSON，插件直接显示external数量、free/locked合计、可靠USDT报价、估值、已定价部分占比、采集时间和缺口。不将USDT当USD，不推断LD等前缀/成本/收益；未知资产保留unknown，缺价不作0。全部余额字段缺失/重复/不合法拒绝，成功空数组才是真零。
- 与币安Spot页逐项核对free/locked/总数量及资产行数；Funding/Stocks不属于覆盖范围。仅本机会话显示，不能写主程序账本/导出/备份；只记录脱敏“对账通过/失败”，不记录真实UID/数量或原始日志。
- 本人对账后勾选确认，开启5分钟刷新；等至少一次实际自动请求，核对采集时间变更、数量未累加。自动默认关闭，只有一个页面定时器，不允许并发。
- 余额与价格6分钟TTL（仅真实链路；旧60秒/120秒模拟测试不变）。瞬时故障立即失效并保留旧数量；普通网络/超时自动退避10/20/30分钟，修正配置后本人断开并重新确认可清除普通退避。429/418独立按Retry-After冷却，无有效秒数时分别60秒/30分钟，断开/保存/重新确认不清除；迟到响应也保留冷却，不能拿重连规避。当前冷却保留于插件会话，不保证跨进程持久化；不要重启/重装来重置限流。认证/权限/UID/格式异常停连。缺价保留数量和部分估值。
- 切页/最小化使document隐藏时暂停，返回后到期补查；不承诺后台刷新，须实测宿主是否派发visibilitychange。禁用插件清理会话，重启后自动与同意不恢复，已有secrets不会自动发请求。断开阻止新请求、拒绝迟到结果；SDK不能撤回已发请求，超时后底层未结束不重叠。
- 删除凭据需本人确认；先断开，再删除所有真实secrets槽并读回null；卸载/删除本机凭据不会撤销币安端Key。

## v0.1.10安全诊断

在2MiB字符/UTF8上限内解析错误code，HTTP400的-1022/-1021分别报签名/时间窗口，-2014/-2015报认证；非JSON按HTTP状态分类，429/418优先冷却。界面只显示固定阶段、安全码、HTTP与整数业务码，不显示msg、认证响应、URL或凭据。只读检查分别报告读取关闭/IP白名单关闭/额外权限/字段不完整，只显示必要已知字段与布尔或缺失状态；未知true权限仍拒绝但不回传其任意字段名。宿主签名URL日志剩余风险没有修复。

打开页面只查secrets活动标记，可能存在无效槽；它表示“已保存标记”，不代表密钥有效。本人查询时再完整读回并核验。当前任务安装后停在未连接、等待本人确认查询，不由助手点击真实认证。

## 依据与复用范围

- [Binance account官方接口](https://developers.binance.com/docs/binance-spot-api-docs/rest-api/account-endpoints)：GET account、SPOT、uid、balances；账户canTrade等不是Key只读证明。
- [Binance API权限官方接口](https://developers.binance.com/docs/wallet/account/api-key-permission)：GET apiRestrictions。enableReading和ipRestrict须为true；9项交易/提现/划转等字段须明确false，新未知true权限拒绝。缺字段不能猜作false。
- 仅参考[crypto-wealthfolio-addon](https://github.com/jimmylin0979/crypto-wealthfolio-addon/tree/82a56aa8bc92975b3d91e33f746ac19746418ba0)指定三个文件，MIT Copyright (c) 2026 jimmylin0979。没有复制其实现，签名/精度/风险复用本项目代码；不采用空余额降级、USD现金合并、前缀改写或原始异常输出。若后续复制其代码，必须随产物保留原MIT版权与许可全文。
