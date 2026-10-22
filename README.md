# DSH Agent（Obsidian 插件）

在 Obsidian 右侧边栏里和内建的 **DeepSeek Harness** 运行时聊天。插件通过
[ACP（Agent Client Protocol）](https://agentclientprotocol.com) 驱动本机的
`dsh acp` 进程：可以读改当前 Vault、调用工具、请求权限，并把当前笔记或选区
作为上下文附带发送。

- 插件 id：`dsh-agent`
- 显示名称：**DSH Agent**
- 仅桌面端（`isDesktopOnly: true`）
- 运行时：DeepSeek Harness 桌面版自带（`resources/runtime/cli/bin/dsh`）

## 前置条件

1. Obsidian 桌面版 ≥ 1.8（当前在 1.14.4 上验证）。
2. 已安装并登录 **DeepSeek Harness** 桌面版（本机默认路径
   `%LOCALAPPDATA%\Programs\DeepSeek Harness`）。
3. 已关闭 Vault 的「受限模式」，并在「设置 → 第三方插件」中启用本插件。

## 使用

- 点击左侧功能区（ribbon）的对话图标，或命令面板执行 **打开 DSH 对话面板**。
- 面板布局（参考 Pi Agent）：
  - 顶部：品牌图标 + 当前会话标题，右侧为 **新对话 / 历史 / 更多** 三个图标按钮；
    标题下方是一行紧凑的运行状态（未连接 / 启动中 / 就绪 / 错误）。
  - 消息区是一张带边框的卡片，每条消息由「角色行 + 内容卡片」组成：
    用户消息带主题色底纹，DSH 回答为普通卡片；思考过程折叠，工具调用默认隐藏。
    鼠标悬停 DSH 角色行时出现 **复制 / 插入到光标 / 替换选区** 三个图标按钮。
  - 输入区：输入框上方一行左侧是 **当前笔记 / 选中内容** 两个上下文开关、右侧是上下文用量，
    下面是输入框；底部运行栏是 **模型 / 推理强度** 按钮（点开为主题化菜单）和 **发送** 按钮。
- 输入：
  - `Enter` 发送、`Shift+Enter` 换行（可在设置中改为 `Ctrl/Cmd+Enter` 发送）；
  - 处理中发送按钮变为红色 **停止**（发送 ACP `session/cancel`）。
- 工具调用默认**不显示**；可在设置里改为「只显示最新一条」或「显示全部」。需要确认时仍会出现 **允许 / 拒绝** 卡片（若 DSH 提供「始终允许 / 始终拒绝」，也会显示对应按钮）。
- 生成过程中只显示「DSH 正在回复…」状态行；完成后一次性显示完整回复卡（同一轮多次输出合并为一张）。
- 失败、取消、token 上限等以居中提示显示。

### 相关命令

| 命令 | 说明 |
|---|---|
| 打开 DSH 对话面板 | 打开/聚焦右侧面板 |
| 询问选中内容（DSH） | 打开面板并预填「解释选中内容」 |
| 把当前笔记发给 DSH | 预填「总结当前笔记」 |
| 新建 DSH 对话 | 关闭当前会话并新建 |
| 重启 DSH 运行时 | 停掉子进程后重新启动并尝试恢复当前会话 |
| 查看 DSH 运行时日志 | 打开 stderr / 诊断日志窗口 |

编辑器右键菜单也有 **发送到 DSH**（选中文本时出现）：点击后立即把选区作为上下文发送，
并自动提问「解释这段选中内容…」，不需要再手动回车。

上下文的读取不再依赖「当前活动视图」：即使焦点在聊天面板里，也会使用**最近一次活动的
Markdown 笔记**及其选区，所以选中文字后直接点面板发送也能带上选区。

## 它是怎么连上 DSH 的

1. 插件发现启动器（设置 → 连接）：
   - 设置中的路径；否则 PATH 里的 `dsh`；否则桌面安装目录
     `…\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd`（macOS/Linux 同理）。
   - 桌面安装会直接以 `ELECTRON_RUN_AS_NODE=1` 启动
     `DeepSeek Harness.exe --expose-internals …\app.asar\dsh\…\cli.js`，
     等价于官方 `dsh` 包装脚本，避免 `cmd.exe` 引号问题。
2. 以 Vault 根目录为 `cwd` 运行 `dsh acp --patch <生成的覆盖文件>`，
   通过 stdio NDJSON 进行 ACP v1 握手（`initialize` / `session/new` /
   `session/prompt` / `session/update` / `session/request_permission` …）。
3. 首次启动会在 `~/.dsh/profiles/acp` 下创建 DSH profile（DSH 的正常行为），
   之后复用同一 profile 与会话存储；会话也保存在 `~/.dsh/sessions`。
4. **模型路由**：ACP profile 自带的默认路由是 `deepseek-official`（API Key 路由），
   而桌面版通常使用账户路由。插件会自动读取
   `~/.dsh/profiles/desktop/cordis.patch.yml` 中 `agent-default-model` 的
   `provider` / `model`，生成一个 `--patch` 覆盖（本机为
   `deepseek-account` / `deepseek-flash`）。也可以在设置里手动指定。

> 插件不接触任何凭据；模型账号、会话与工具权限都由 DSH 运行时负责。

## 设置项

设置页顶部是状态卡片（运行时状态、检测到的启动器路径，以及 **检测连接 / 重启运行时 / 查看日志** 三个操作），
下面按卡片分组：

| 分组 | 设置 | 默认 | 说明 |
|---|---|---|---|
| 连接与模型 | DSH 启动器路径 | 空（自动） | 可填 `dsh` 或绝对路径 |
| 连接与模型 | DSH_HOME | 空（`~/.dsh`） | 自定义运行时主目录 |
| 连接与模型 | Provider / Model 覆盖 | 空（自动读取桌面版） | 写入生成 `--patch` 的 `acp` 条目 |
| 笔记上下文 | 附带当前笔记 / 优先选区 | 开 / 开 | 控制默认 chip 状态 |
| 笔记上下文 | 最大字符数 | 8000 | 超出截断 |
| 笔记上下文 | 附带笔记文件链接 | 开 | 额外发一个 `resource_link`，agent 可自行读取整篇笔记 |
| 面板交互 | 自动允许工具调用 | 关 | **危险**：不再询问就执行读写/命令 |
| 面板交互 | 工具调用显示 | 不显示 | 可选：不显示 / 只显示最新一条 / 显示全部 |
| 面板交互 | 显示思考过程 | 开 | reasoning 折叠展示 |
| 面板交互 | Enter 发送 | 开 | 关闭后为 `Ctrl/Cmd+Enter` |
| 面板交互 | 随 Obsidian 启动运行时 | 关 | 关闭时首次使用才启动 |
| 诊断 | 记录协议日志 | 关 | JSON-RPC 帧写入控制台与日志窗口 |
| 高级（折叠） | 额外启动参数 | 空 | 追加到 `dsh acp` 之后，按空格拆分 |
| 高级（折叠） | 额外 profile patch | 空 | YAML 片段追加到生成的覆盖文件（高级排错） |
| 高级（折叠） | MCP 服务器（JSON） | 空 | 传给 `session/new` 的 `mcpServers` 数组 |

## 已知限制

- ACP 的更新是**提交粒度**（整条 assistant 消息 / 工具事件），不是逐 token 流式。
- ACP 不暴露计划、待办、终端、标题、多目录等 DSH 专有界面；`session/resume`
  也不回放历史。插件会在本地缓存并显示自己创建的会话历史；从其他客户端
  （例如桌面版 GUI）导入的会话只显示「历史不可用」提示。
- 每个窗口 / Vault 各自启动一个运行时子进程；与桌面版 GUI 不共享实时会话。
- 桌面版注册的账户路由可能以 `x-client-platform: web` 发出（ACP profile 的默认）；
  若账户校验因此失败，可在「额外 profile patch」里加：
  ```yaml
  - id: deepseek-account
    config:
      desktopPlatform: win32
  ```
- 不支持移动端、图片输入、只读模式下自动执行工具。

## 安全

运行时以 Vault 根目录为工作区，使用 DSH 默认的 `workspace-write` 预设：

- Vault 内的读写通常直接执行；
- 越过工作区（例如写到用户目录、访问受限路径）会被沙箱拒绝，DSH 通过 ACP
  发出审批请求，插件显示 **允许 / 拒绝** 卡片（若 DSH 返回「始终允许 / 始终拒绝」选项也会显示）；允许后 agent 会重试该命令；
- 打开「自动允许工具调用」等于跳过这道确认。

请只在自己信任的 Vault 中使用。工具的实际权限仍由 DSH 的 profile 预设
（`read-only` / `workspace-write` / `danger-full-access`）决定。

## 开发

依赖：Node.js ≥ 22（本机 24）、npm。

```powershell
cd .obsidian/plugins/dsh-agent
npm install --ignore-scripts        # 受限环境可加 --ignore-scripts
node scripts/build.mjs              # 由 src/ 生成 main.js（无 esbuild 依赖）
node node_modules/typescript/bin/tsc --noEmit
node --test --test-isolation=none "test/*.test.mjs"
node scripts/smoke-bundle.mjs       # 用 stub 的 obsidian 模块加载打包产物
node scripts/smoke-acp.mjs          # 真实 dsh acp 冒烟（需要正常权限）
```

也可以使用 npm 脚本：`npm run build`、`npm run typecheck`、`npm test`。

### 目录

```
manifest.json         插件清单
main.js               构建产物（Obsidian 直接加载）
styles.css            面板样式
src/
  main.ts             插件生命周期、命令、状态栏
  settings.ts         设置模型与设置页
  runtime.ts          启动器发现 / 子进程 / 日志 / 关停
  acp/transport.ts    NDJSON JSON-RPC 传输
  acp/client.ts       ACP v1 方法封装
  acp/protocol.ts     wire 类型与配置选项工具
  session.ts          单会话状态机（发送/更新/权限/取消）
  transcript.ts       会话条目 reducer（纯函数）
  store.ts            转录落盘（vault adapter）
  context.ts          笔记上下文构建（纯函数）
  view.ts             侧边栏 ItemView + 历史/日志弹窗
  render.ts           Markdown 与文本渲染辅助
  i18n.ts             中英文案
test/                 单元 + 进程内 mock ACP 集成测试
scripts/build.mjs     零依赖构建（ts.transpileModule + 迷你模块系统）
scripts/smoke-*.mjs   产物冒烟 / 真实运行时冒烟
```

### 打包说明

本仓库没有使用 esbuild：其 JS API 需要 spawn 原生二进制，在受限沙箱中会
`spawn EPERM`。`scripts/build.mjs` 用 TypeScript 编译器在进程内转译每个
`src/**/*.ts` 为 CommonJS，静态映射相对导入，再输出一个带微型模块表的
`main.js`；入口的 default export 会作为 `module.exports`。

## 排错

| 现象 | 处理 |
|---|---|
| 状态「未找到 DeepSeek Harness」 | 在设置里填写启动器路径，点「检测」 |
| 启动失败 / 一直「启动中」 | 打开 ⋯ → 查看日志；注意首次启动会创建 `~/.dsh/profiles/acp` |
| 创建会话失败（模型路由） | 设置 Provider/Model，或在桌面版登录；查看错误里的 DSH code |
| `session/resume` 失败 | 会话可能已被其他客户端占用或 cwd 不一致；新建对话即可 |
| 插件没出现在第三方插件列表 | 确认文件夹为 `.obsidian/plugins/dsh-agent` 且含 `manifest.json`；关闭受限模式；重启 Obsidian |
| 关闭 Obsidian 后有残留进程 | 到任务管理器确认 `DeepSeek Harness.exe`（运行 cli.js 的那个）；插件卸载时会发 EOF 并兜底 `taskkill /T` |
