# Spot 本地接入：用户已批准手动快照交接

日期：2026-10-15。基线 a60a032 / v0.1.7。用户明确选择“接受本地辅助程序＋手动快照交接”。v0.1.8已实现Windows本机读取器和独立导入/估值，具体说明见native/README.md；默认虚构模式，真实请求未启用，实机进度见VALIDATION。下文保留作出此决定的证据与约束。

## 已核实的阻塞

- 本机 E:\Wealthfolio\Wealthfolio.exe 已为3.10.0，本轮未升级/降级。3.9.1目标与实机不符，不能将本轮测试写成3.9.1验收。
- 官方3.9.1和3.10.0的 [network.rs](https://github.com/wealthfolio/wealthfolio/blob/v3.10.0/crates/core/src/addons/network.rs) 第103/121行仍将reqwest原异常转成字符串；[core.ts](https://github.com/wealthfolio/wealthfolio/blob/v3.10.0/apps/frontend/src/adapters/tauri/core.ts) 第50行先写invoke错误日志。插件catch晚于宿主日志。未发现可由插件启用的受支持URL脱敏接口。
- 相同network.rs拒绝localhost、loopback和解析为私网的地址，见237—300行及相关测试；HTTPS localhost也不能批准。因而“本地HTTP服务 + 插件network.request”不可用。禁止用fetch、DNS映射、关闭TLS或修改主程序绕过。
- SDK3.9.0的FilesAPI只有openCsvDialog（返回路径）、openSaveDialog，无通用文件读取、原生进程启动或命名管道能力。不能承诺插件自动读取本地辅助程序生成的文件。

## 已批准的最小方案

一个独立本地只读辅助程序负责凭据与签名，只请求官方time和Spot GET /api/v3/account；结果通过用户主动复制/粘贴的严格白名单余额JSON交给插件。不开放监听端口、不经云端、不让宿主接触认证URL。插件保留现有公开行情代理及估值纯函数，新增独立external余额导入入口，不复用旧模拟备份恢复入口。后续如实测浏览器用户选文件能力可用，可在同一导入边界支持用户主动选文件；不是前置依赖。

凭据由辅助程序使用[Windows用户级DPAPI](https://learn.microsoft.com/en-us/windows/win32/api/dpapi/nf-dpapi-cryptprotectdata)或Credential Manager保存，不读取Wealthfolio的secrets或其他插件命名空间；不能宣称用户级加密能防同Windows用户恶意进程。用户在辅助程序本地密码框输入，禁止命令行参数、环境变量、明文配置、剪贴板传递凭据。替换使用候选后切换，断开阻止新请求，删除须读回核对；币安端撤销由用户操作。

网络固定HTTPS主机/GET/两条路径、禁止重定向、证书校验开启、无原始异常/URL/header/body日志、日志仅批准错误码。开发模式只接受固定假凭据和注入故障传输，真实网络模式必须由用户另行确认，不能把测试密钥发到真实接口来验证安全。

余额输出只含来源、钱包Spot、来源账户稳定身份、free/locked/quantity和采集起止/状态等白名单字段，无Key/Secret/签名/完整URL；真实零、失败、过期、缺价语义沿用。失败也必须传递状态，导入失败不得留下旧的“当前成功”；用户不重新导入时，原快照依60秒TTL失效。现有报价仅五个市场，其他资产保持缺价；不扩展行情范围或其他钱包。

## 必须由用户决定的取舍

- 推荐：接受“本地辅助程序手动读取 → 用户主动导入插件”，可避开宿主签名日志路径，最小实现无需服务。代价是两个本地入口、每次余额刷新需要交接；余额JSON/剪贴板包含资产隐私，需避免云剪贴板/上传和其他应用读取。此流程不属于自动同步。
- 如必须在Wealthfolio内一键自动刷新：当前两版本官方SDK不足以同时满足约束，应等待官方修复或提供受支持本地桥接；本轮不擅自Fork、升级、绕过或改成独立产品。

用户已选定交接方式。原生自检已完成加密存储生命周期、真实loopback HTTP假签名、连接中断/响应body停滞、限流与错误脱敏，以及快照到插件计算；原生TLS证书握手故障和实际Binance认证未实测。完成Windows界面虚构交接后停止，再由用户决定首次真实认证。不会将本地读取器的安全结果说成宿主漏洞已修复。
