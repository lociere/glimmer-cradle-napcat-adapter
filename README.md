# Glimmer Cradle NapCat Adapter

面向微光摇篮的第三方 NapCat / OneBot 集成。该仓库独立维护 OneBot 11 协议桥，以及按 profile 切分的外部上游接入与 Desktop Windows 受管 NapCat 管理，不属于微光摇篮第一方扩展源码仓库。

## 边界

- 本仓库只保存 Adapter 源码，不保存 NapCat、QQ、账号、token、日志或本机状态。
- NapCat 来自上游 `NapNeko/NapCatQQ` Release，并遵循上游许可证与使用约束。
- 扩展只依赖公开的 `@glimmer-cradle/extension-sdk` 与 `@glimmer-cradle/protocol`。
- 发布物是不可变 `.gcex`，安装后进入 `data/packages/extensions/lociere.napcat-adapter/<version>/`。
- NapCat 程序包进入 `data/packages/managed-resources/lociere.napcat-adapter/napcat/`；连续性状态进入 `data/state/extensions/lociere.napcat-adapter/`。

## Profile

- `profile.mode=external_onebot`
  - 默认最小可运行形态。
  - 适用于 Personal Server / Linux，也可用于 Desktop。
  - 扩展只监听 OneBot 反向 WebSocket，不管理第三方 NapCat / QQ 进程，也不暴露 WebUI 管理命令。
- `profile.mode=managed_napcat_windows`
  - 仅适用于 Desktop Windows x64。
  - 扩展受管 NapCat 上游进程、QQ 注入探活和 WebUI 管理命令。
  - 相关 command / managedResource / setting 通过 manifest contribution `requirements` 限定到 `desktop + windows-x64`。

`glimmer.skill` 中的 `qq-source-context` 是 source-provider 私有人物 Skill，只在 `lociere.napcat-adapter` 产生的 ConversationContext 内可见，用于描述当前 QQ / OneBot 场景的回复与约束；二维码、快速登录、打开 WebUI 等管理能力仍保持 `user` audience，不伪装成人物 Skill。

## 开发

正式 CI 从包仓库安装语义化版本的 SDK 与 Protocol。两个公开包尚未发布时，可在主仓库先执行 `pnpm build:extension-tooling`，再使用本仓库的本地 SDK 链接脚本建立不入 Git 的开发链接。

```powershell
pnpm install --config.auto-install-peers=false
node scripts/link-local-sdk.mjs C:\path\to\glimmer-cradle
pnpm validate
$env:GCEX_PLATFORM='linux-x64'; pnpm release:prepare
```

## 发布

```powershell
pnpm release:prepare
```

命令会在 `release/` 生成标准 `.gcex` 与 `release-manifest.json`。`.gcex` 自带全量摘要和 SPDX 2.3 SBOM，无论通过 Registry、仓库 Release 还是本地包安装都使用同一份供应链信息。Registry 只保存审核状态和清单地址，不复制扩展权限、平台、Contribution 声明或 SBOM，也不托管发布物。

NapCat 上游项目：https://github.com/NapNeko/NapCatQQ
