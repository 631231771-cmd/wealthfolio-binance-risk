# 当前状态

2026-10-15。唯一根目录F:\Code\风控，分支feature/spot-readonly-offline；已推送基线a60a032/v0.1.7，CI38692606816成功。本轮v0.1.8工作区新增本地读取器及快照交接，用户已明确批准这条路线；本轮已授权正常提交推送，界面验收未完成；实际提交/CI以Git和本地收据为准，main不变。

## 已完成且验证

- 官方3.9.1与3.10.0均仍有原reqwest错误→invoke日志链路风险，且拒绝localhost/loopback/私网。本机宿主已为3.10.0，本轮未升级/降级；不能记成3.9.1实机通过。
- v0.1.7用户安装到独立WRISK测试资料库，虚构凭据保存、真实关窗重启读回、替换及用户删除全部通过，删除结果为空；原30000/5500保持。没有真实密钥或认证请求，未改DeepSeek/其他资料库配置。
- v0.1.8独立Windows读取器：WinForms/DPAPI/HttpClient，固定Spot GET time/account，无监听服务/第三方依赖。默认虚构模式；只有显式--allow-live及界面确认才可真实请求，当前未启动真实模式。预期UID核对、密文候选核验后原子替换、取消/超时/限流、固定错误码，无原始URL/header/body/异常日志。
- 插件撤下真实凭据输入，独立spot-bridge严格白名单导入；来源/UID/采集时间/状态保留，fixture和external不混合、重复替换不累加；复用五个公开USDT市场报价。真实余额不写宿主/备份，不与旧模拟数量合计；缺价/过期/失败不当0。
- 本机完整verify通过96项TS测试、类型、构建、ZIP、smoke和原生自检；原生增加body停滞故障发现取消信号不足，已改为总时限主动关闭流并重跑通过。当前原生自检13项，覆盖DPAPI独立进程生命周期、真实loopback HTTP假签名/失败/中断/body超时/限流及日志保护，输出JSON实际进入插件解析计算。没有访问Binance私人主机。
- ZIP artifacts/wealthfolio-binance-risk-0.1.8.zip，SHA256 bbb760f1fd8d8b3ce486195eef0ac81317ed6c10549b8543e6ed773e53565f66。
- 读取器 artifacts/spot-reader/WealthfolioSpotReader.exe，FileVersion0.1.8.0，SHA256 71f83501613e8e6e6390ea3ff89cf3fb2ebf8b0a95a52ecf640dc76b34f72395；说明和自检结果同目录。产物不入Git。

## 尚未完成与限制

- v0.1.8官方桌面安装及辅助程序GUI假凭据/手动快照导入，等待用户批准后执行；不把HTTP自检或编译当成界面通过。
- 手动读取失败必须交接failed快照或空导入，未交接时插件最多等余额60秒TTL才失效；不是自动同步。数量保留、报价120秒TTL，NOPAIR等缺价，USDT不默认USD。
- DPAPI不防同用户恶意进程/管理员/调试；凭据短暂在辅助程序内存。JSON/剪贴板有资产隐私，mode不是来源加密证明，不能上传。真实数据只在插件会话内存，不能因此宣称内置AI隔离已完整验证。
- 宿主签名日志漏洞未修复，插件认证仍硬阻断。原生TLS证书故障、真实Binance Key只读/IP权限、余额与UID对账、AI隔离与真实备份未验证。Funding/Stocks不支持；未调用Astra、未修改宿主或旧WorldState。

## 下一步唯一优先任务

完成用户批准后的v0.1.8虚构Windows界面交接与Git/CI交付，然后立即停止，等待用户确认首次独立小额测试账户真实只读请求。当前不启动真实模式，不索取真实Key。
