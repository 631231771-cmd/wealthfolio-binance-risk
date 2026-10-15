# 当前状态

2026-10-15。唯一目录F:\Code\风控；分支feature/spot-readonly-offline，v0.1.8。原生读取器/快照交接已提交4bda3e7，CI38697340415成功；本轮继续做最小加载兼容修正与真实界面验收，后续提交/CI以Git及artifacts/CI-RECEIPT-0.1.8.json为准，main不变。

## 已完成且验证

- 用户批准本地只读辅助程序＋手动快照。实际宿主为3.10.0，本轮未升级/降级；独立资料库WRISK Windows验收20261013，未改DeepSeek或其他资料库。不能记为3.9.1实机通过。
- v0.1.7官方secrets固定假值保存、真实关窗重启读回、替换和用户删除通过；v0.1.8撤下插件真实凭据输入。
- v0.1.8首次包管理器识别但页面Unexpected token ':'失败。只将SpotBridge.import改名importSnapshot及相关调用后，用户重装成功；真实关窗重启后页面也正常。增加编译入口无动态import/同名方法检查；未确定宿主内部具体重写位置，不声称修改了宿主。
- 原生WinForms/DPAPI/HttpClient默认虚构GUI：初始无凭据、A保存核验/清空、关闭重开读回且无自动请求、B替换、生成fixture快照；用户删除后读回为空、读取按钮禁用、输出清空，程序已关闭。未启动--allow-live。
- 真实GUI手动交接四条fixture：BTC0.001、ETH0.02、USDT15（free12/locked3）、NOPAIR2；来源/UID900000001/采集时间正确。同一有效快照重复导入仍四条，未累加；空/过期导入使当前不可用并保留历史数量；自然余额TTL也使当前不可用。旧30000 USD/5500 USD在重启后保持独立。
- 更新后公开主机曾为已拒绝，由用户勾选唯一data-api.binance.vision并保存；重启后五个公开市场真实读取成功。报价采集07:30:53.994Z，BTC81170.39、ETH2369.57；新fixture余额07:31:22.1281303Z，定价部分143.56179000 USDT、损失25.71235800，与手算一致；NOPAIR缺价，完整总额不可用。
- 修正后本机完整npm run verify通过：96项TS、类型、构建/ZIP/smoke/receipt、13项原生DPAPI/HTTP假签名与故障自检、原生输出→TS解析。CI不替代GUI；自检未接私人Binance主机。
- 保留实机验收产物：artifacts/wealthfolio-binance-risk-0.1.8.zip SHA256 6964e0499ac47ef789d33bb5897b0140036edb89d950b1a0e3a5dc0f01429eb4；artifacts/spot-reader/WealthfolioSpotReader.exe SHA256 71f83501613e8e6e6390ea3ff89cf3fb2ebf8b0a95a52ecf640dc76b34f72395。完整verify重建包四项内容与实机包一致，恢复保留已验收的原始ZIP/EXE；产物不入Git。

## 限制与未验证

- 宿主签名URL日志风险仍存在，插件认证硬阻断；认证仅由独立原生进程承担，没有服务/localhost绕过。默认虚构；真实模式必须再次获得用户明确授权。
- 手动读取失败必须交接failed快照/空导入，否则最多等余额60秒TTL；价格120秒。价格失效不再赋给当前快照，因此历史可定价部分也可能只剩同币种USDT；未额外保存最后一次完整估值报告。不是自动同步或完整账本。
- DPAPI不防同用户恶意进程/管理员/调试；凭据短暂在内存。余额JSON/剪贴板有隐私；mode不是来源加密证明。真实数据仅插件会话内存，不写宿主/备份。
- 真实Binance认证/TLS证书故障/真实Key只读与IP权限/UID及余额对账/AI隔离尚未实测。真实零、恶意字段与凭据保存故障由自动化覆盖，未在宿主注入这些故障。
- 重启宿主仪表盘曾提示“投资组合更新失败”，仍显示旧WRISK模拟30000；本轮插件没有主程序写权限，未定位或修改该宿主提示。Funding/Stocks不支持；未调用Astra。

## 下一步唯一优先任务

等待用户决定首次独立小额账户真实只读验证；按native/README.md由用户核对只读/IP/UID和测试资料库AI隔离，再在本机密码框输入。当前停止，不启动真实模式、不索取或发送真实Key。
