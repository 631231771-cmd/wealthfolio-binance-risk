# 阶段 A：官方插件接口核查

核查日期：2026-10-13。固定 [Wealthfolio v3.9.1](https://github.com/wealthfolio/wealthfolio/tree/v3.9.1)，标签解析到 commit `392f272c5b15a4af45dc2ff71dcbec474f47112a`。当前网站文档会更新，以固定标签源码为准。

结论：**源码层面可行，可实施阶段 B**。插件具备正式账户与快照写入路径，不必绕过主程序。实际发行版安装和宿主调用仍需要独立实测，不能由源码或替身测试代替。

| 问题 | 核实结果 | 证据 |
|---|---|---|
| 官方 Windows 安装运行 | 有 x64/arm64 官方 EXE/MSI，插件支持本地 ZIP；实际安装未完成 | [发行版](https://github.com/wealthfolio/wealthfolio/releases/tag/v3.9.1)、[入门文档](https://github.com/wealthfolio/wealthfolio/blob/v3.9.1/docs/addons/addon-getting-started.md) |
| 独立页面 | manifest contributes + router.add，路由 id 必须相同；主程序管理 React 根 | [清单](https://github.com/wealthfolio/wealthfolio/blob/v3.9.1/packages/addon-sdk/src/manifest.ts) |
| 读取账户/持仓 | accounts.getAll、portfolio.getHoldings；需相应权限 | [SDK](https://github.com/wealthfolio/wealthfolio/blob/v3.9.1/packages/addon-sdk/src/host-api.ts) |
| **纳入主程序资产管理** | **accounts.create、HOLDINGS 模式 snapshots.save / importSnapshots；activities.create/update/saveMany/import 也存在**。本版只验证快照，不构造交易历史 | [真实桥接](https://github.com/wealthfolio/wealthfolio/blob/v3.9.1/apps/frontend/src/addons/type-bridge.ts)、[账户字段](https://github.com/wealthfolio/wealthfolio/blob/v3.9.1/crates/core/src/accounts/accounts_model.rs)、[持仓保存](https://github.com/wealthfolio/wealthfolio/blob/v3.9.1/crates/core/src/portfolio/snapshot/manual_snapshot_service.rs) |
| 插件持久化 | storage.get/set/delete，宿主 SQLite、按插件隔离；不是沙箱 localStorage | [SDK 存储接口](https://github.com/wealthfolio/wealthfolio/blob/v3.9.1/packages/addon-sdk/src/host-api.ts) |
| 密钥 | secrets.set/get/delete，桌面 OS 凭据存储；未来 HMAC 需读入插件内存，非托管签名 | [Windows secret store](https://github.com/wealthfolio/wealthfolio/blob/v3.9.1/apps/tauri/src/secret_store.rs) |
| 请求币安 | network.request 经宿主代理，允许自定义 X-MBX-APIKEY；仅 bearer/basic 内置 auth，没有币安 HMAC 类型 | [网络源码](https://github.com/wealthfolio/wealthfolio/blob/v3.9.1/crates/core/src/addons/network.rs) |
| 限制 | HTTPS/主机审批、拒私网/localhost、拒重定向、限制部分请求头；ZIP 清单+ES模块，宿主依赖外置。本轮源码未见本地插件 ZIP 必须单独密码学签名的要求；桌面安装包签名不是插件签名 | [网络校验](https://github.com/wealthfolio/wealthfolio/blob/v3.9.1/crates/core/src/addons/network.rs)、[官方打包模板](https://github.com/wealthfolio/wealthfolio/blob/v3.9.1/packages/addon-dev-tools/templates/vite.config.ts.template) |
| 主程序升级 | API、宿主依赖/权限/路由/数据格式可能变化；新权限需重新审批 | [插件说明](https://wealthfolio.app/docs/addons/)、[启动逻辑](https://github.com/wealthfolio/wealthfolio/blob/v3.9.1/apps/frontend/src/addons/addons-core.ts) |

## 必须保留的边界

- 页面贡献默认首次访问才启动；没有闭程序后台同步服务。
- 快照按日期写入，不能视为交易流水或完整日内审计。多个账户保存没有 Addon 层跨账户事务。
- 上游保存可能修改复用资产的 MANUAL 报价模式，演示须独立资产标识。
- [便携备份明确移除 addon storage](https://github.com/wealthfolio/wealthfolio/blob/v3.9.1/docs/architecture/database-encryption-and-backups.md)，所以增加插件状态单独导出，不声称主程序备份保留全部插件数据。
- SDK 包在 v3.9.1 中版本为 3.9.0，npm 同名版本已存在。本轮锁版本，不复制上游源码。
- 如果正式发行版出现关键桥接阻断，暂停；记录实际错误，不改主程序，也不未经授权换架构。
