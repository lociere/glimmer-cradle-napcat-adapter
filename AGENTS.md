# Glimmer Cradle NapCat Adapter 协作约定

- 本仓库是独立第三方集成，不是 Glimmer Cradle 第一方扩展。
- 运行边界以 `extension-manifest.yaml` 和公开 Extension SDK 为准，不得引用 Kernel、Cognition、Contract Spine 包或产品源码。
- 当前发行物顶层可声明 `desktop + personal-server` 与 `windows-x64 + linux-x64`，但 profile owner 必须明确：
  - `profile.mode=external_onebot` 是默认最小可运行形态，可用于 Personal Server / Linux，由用户自管 OneBot / NapCat 上游反向连接。
  - `profile.mode=managed_napcat_windows` 只允许在 Desktop Windows x64 上显式启用，负责受管 NapCat 进程与 WebUI 管理闭环。
- 不得再引入第二份 manifest 或旧 `managed_process_enabled` 双主线；profile-specific 能力必须通过 contribution `requirements.products/platforms/features` 投影。
- NapCat 与 QQ 二进制包、配置、账号、token、二维码、日志和 cache 不得进入 Git。
- 扩展包、第三方受管资源和扩展状态必须分别进入 `data/packages/extensions/`、`data/packages/managed-resources/` 与 `data/state/extensions/`。
- 所有命令、owner、provider 和扩展 ID 使用 `lociere.napcat-adapter` 命名空间。
- 摇篮完整首版发布候选形成前，Adapter、manifest 与公开 SDK 依赖统一保持 `0.1.0`，不得按开发进度提前递增；后续版本只随通过门禁并获授权的完整发布原子更新。
- TypeScript 使用项目锁定的 pnpm；文本文件使用 UTF-8 无 BOM。
