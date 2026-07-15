# Glimmer Cradle NapCat Adapter 协作约定

- 本仓库是独立第三方集成，不是 Glimmer Cradle 第一方扩展。
- 运行边界以 `extension-manifest.yaml` 和公开 Extension SDK 为准，不得引用 Kernel、Cognition 或产品源码。
- NapCat 与 QQ 二进制包、配置、账号、token、二维码、日志和 cache 不得进入 Git。
- 扩展包、第三方受管资源和扩展状态必须分别进入 `data/packages/extensions/`、`data/packages/managed-resources/` 与 `data/state/extensions/`。
- 所有命令、owner、provider 和扩展 ID 使用 `lociere.napcat-adapter` 命名空间。
- TypeScript 使用项目锁定的 pnpm；文本文件使用 UTF-8 无 BOM。
