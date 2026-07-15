# Glimmer Cradle NapCat Adapter

面向微光摇篮的第三方 NapCat 集成。该仓库独立维护 OneBot 11 协议桥、NapCat 进程监督和 WebUI 管理，不属于微光摇篮第一方扩展源码仓库。

## 边界

- 本仓库只保存 Adapter 源码，不保存 NapCat、QQ、账号、token、日志或本机状态。
- NapCat 来自上游 `NapNeko/NapCatQQ` Release，并遵循上游许可证与使用约束。
- 扩展只依赖公开的 `@glimmer-cradle/extension-sdk` 与 `@glimmer-cradle/protocol`。
- 发布物是不可变 `.gcex`，安装后进入 `data/packages/extensions/lociere.napcat-adapter/<version>/`。
- NapCat 程序包进入 `data/packages/managed-resources/lociere.napcat-adapter/napcat/`；连续性状态进入 `data/state/extensions/lociere.napcat-adapter/`。

## 开发

正式 CI 从包仓库安装语义化版本的 SDK 与 Protocol。两个公开包尚未发布时，可在主仓库先执行 `pnpm build:extension-tooling`，再使用本仓库的本地 SDK 链接脚本建立不入 Git 的开发链接。

```powershell
pnpm install --config.auto-install-peers=false
node scripts/link-local-sdk.mjs D:\elise\glimmer-cradle
pnpm validate
```

## 发布

```powershell
pnpm release:prepare
```

命令会在 `release/` 生成标准 `.gcex` 与 `release-manifest.json`。`.gcex` 自带全量摘要和 SPDX 2.3 SBOM，无论通过 Registry、仓库 Release 还是本地包安装都使用同一份供应链信息。Registry 只保存审核状态和清单地址，不复制扩展权限、平台、Contribution 声明或 SBOM，也不托管发布物。

NapCat 上游项目：https://github.com/NapNeko/NapCatQQ
