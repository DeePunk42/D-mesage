# D-message 开发与发布规范

npm 只发布正式版。`dev` 分支用于开发、集成和联调，开发者和测试者直接加载源码工作副本，用 Git 提交号标识测试版本。`main` 用于正式发布，每个 npm 版本对应一个固定 Git 标签，例如 `0.1.0` 对应 `v0.1.0`。

## 日常开发

1. 从 `dev` 创建短期分支，如 `feat/trace-search` 或 `fix/repeater-save`。一个分支解决一个问题。通过 PR 合入 `dev`，写清可观察到的变化和验证方法。日常提交沿用已有版本号。
2. 使用 `bun install --frozen-lockfile` 安装依赖。开发时先跑受影响的测试，合并前跑 `bun test` 和 `git diff --check`。改动界面时，用合成数据走一遍实际操作。改动 MCP 时，用客户端列出工具，并走一遍受影响的调用。
3. 修改公开的 MCP 工具、默认行为、安装步骤或存储格式时，在同一 PR 中更新中英文 README。替换或移除已有接口时，说明旧调用如何迁移，并注明首次支持的新版本。

## 本机联调

正式用户按 README 安装精确版本。开发者在独立测试账户或测试机上检出要验证的提交，从仓库根目录运行：

```sh
bun install --frozen-lockfile
bun setup.js
git rev-parse --short HEAD
```

报告问题时附上提交号、Magpie 版本、客户端和请求协议。当前工作区有额外修改时一并注明，便于复现。

插件使用 ID `d-message`，默认页面端口为 `34891`，可选 MCP 端口为 `34892`。同一个 Magpie 实例一次只启用一份 D-message，可用 `magpie plugin list` 查看安装项，用 `magpie plugin off <安装项>` 停用另一份。测试数据目录应与日常使用的目录分开，其中包含 `traces.sqlite`、草稿、录制设置和本机凭据。自定义 `D_MESSAGE_DATA_DIR` 时，确保网关钩子和页面服务都使用同一个测试目录。

## 正式发布

在 `0.x` 阶段，兼容性修复递增补丁号，如 `0.1.0 → 0.1.1`。新增功能或调整公开接口递增次版本号，并在发布说明中单列兼容性变化。

1. **确定发布内容。** 从已在 `dev` 验收的提交创建 `release/*` 分支，设置 `package.json` 的正式版本号，更新两份 README 的安装命令和发布说明，通过 PR 合入 `main`。
2. **验证交付物。** 在干净的 `main` 发布提交上运行 `bun install --frozen-lockfile`、`bun test` 和 `npm pack --dry-run`。核对包内的钩子、页面入口、图标和协议适配器，再用 `npm pack` 生成待发布的 tarball。在测试环境中，先用上一正式版生成合成 Trace、草稿和重放记录，再将 tarball 解包并通过 Magpie 从解包目录加载插件。重启后验证旧记录可读、草稿可恢复，并完成一次新的录制和重放。验收期间如有代码或依赖变更，重新打包并验证。
3. **发布同一份 tarball。** 例如发布 `0.1.0` 时，运行 `npm publish ./magpie-page-d-message-0.1.0.tgz --tag latest`。确认发布成功后，给生成该包的提交打固定标签 `v0.1.0` 并推送，再将正式发布提交合回 `dev`。已发布的 npm 版本号和 Git 版本标签均不可复用。[npm 发布规则](https://docs.npmjs.com/cli/v11/commands/npm-publish/)
4. **从用户入口复查。** 用 `npm view magpie-page-d-message dist-tags --json` 确认 `latest` 指向预期版本，再按 README 中的精确版本从 npm 安装并打开页面。涉及 MCP 时，一并验证客户端能发现工具和读取结果。

## 修复与回退

开发阶段按出错的提交号复现，修复后在 `dev` 重新验证。正式版有紧急问题时，从受影响的正式标签创建 `hotfix/*`，验证后合入 `main`，按正式发布流程发补丁版，再将修复合回 `dev`。

正式版有严重回归时，可用 `npm dist-tag add magpie-page-d-message@<上一正式版本> latest` 将默认安装指回已验证版本。已安装的用户需显式切换版本。涉及数据库迁移时，先在测试环境验证旧程序能读取新数据。需要恢复备份时，先停止插件并保全当前数据，避免覆盖升级后新增的 Trace。[npm 渠道标签](https://docs.npmjs.com/cli/v11/commands/npm-dist-tag/)

## 当前仓库如何开始

以正式标签 `v0.0.1` 为起点，将现有未发布的 MCP、Repeater、界面和文档改动整理到 `dev`，按提交号联调。建议验收通过后直接发布下一个正式版 `0.1.0`。
