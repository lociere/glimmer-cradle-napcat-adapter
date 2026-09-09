# Glimmer Cradle NapCat Adapter

面向微光摇篮的第三方 NapCat / OneBot 集成。该仓库独立维护 OneBot 11 协议桥，以及按 profile 切分的外部上游接入与 Desktop Windows 受管 NapCat 管理，不属于微光摇篮第一方扩展源码仓库。

## 边界

- 本仓库只保存 Adapter 源码，不保存 NapCat、QQ、账号、token、日志或本机状态。
- NapCat 来自上游 `NapNeko/NapCatQQ` Release，并遵循上游许可证与使用约束。
- 扩展只依赖精确版本的公开 `@glimmer-cradle/extension-sdk`；Contract Spine 通过 SDK public edge 消费，不直接依赖 Contract 包或旧 Protocol。
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

正式源码与 manifest 将 SDK peer 精确锁定为 `0.1.8`。公开包尚未发布时，可在主仓库先执行 `pnpm build:extension-tooling`，再使用本仓库的本地 SDK 链接脚本连接 Contract/SDK 发布投影；本地链接不作为正式 Release 的可取得性证据。

```powershell
pnpm install --config.auto-install-peers=false
pnpm link:local-sdk C:\path\to\glimmer-cradle
pnpm validate
$env:GCEX_ALLOW_DIRTY='1'; $env:GITHUB_REF_NAME='v0.1.0'; $env:GCEX_PLATFORMS='windows-x64,linux-x64'; pnpm release:prepare
```

## 发布

```powershell
pnpm release:prepare
```

正式 Release 必须来自干净工作树，且匹配 `package.json`/manifest 版本的精确 `v<semver>` tag 必须真实存在并指向当前 commit。`release:prepare` 会先执行 manifest、类型与测试验证；发布 workflow 固定使用主仓 `extension-sdk-v0.1.8` 的 Contract/SDK 构建投影，并同时生成 Windows x64、Linux x64 `.gcex`、`release-manifest.json` 与 `SHA256SUMS`，每个包在上传前重新验证完整性与 SPDX 2.3 SBOM。`GCEX_ALLOW_DIRTY=1` 只用于本地候选验证，不进入发布 workflow。

`.gcex` 无论通过 Registry、仓库 Release 还是本地包安装都使用同一份供应链信息。Registry 只保存审核状态和清单地址，不复制扩展权限、平台、Contribution 声明或 SBOM，也不托管发布物。

NapCat 上游项目：https://github.com/NapNeko/NapCatQQ
