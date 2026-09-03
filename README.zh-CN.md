# codex-gptpro 中文页面兼容修复版

本仓库保存 `codex-gptpro` 的中文页面兼容修复版本，让本机 Codex 通过 MCP 调用已经登录的 ChatGPT 网页 Pro 模式。

## 上游来源

- 原项目：[tomato-ga/codex-gptpro](https://github.com/tomato-ga/codex-gptpro)。
- 基础提交：[`656d80698758789e6c23b37918372b79c831177e`](https://github.com/tomato-ga/codex-gptpro/commit/656d80698758789e6c23b37918372b79c831177e)。
- 原始 README、代码名称、包名 `codex-gptpro`、MCP 名称 `codex_gptpro` 和 Chrome profile 名称均保留。
- 这是基于该提交建立的独立源码快照，不是上游官方发行版，也没有新增或变更上游许可声明。

## 本版修复

1. **确认 Pro 已选中**：检查模型或思考强度控件，而不是用整页出现 `Pro` 字符串作为依据。
2. **中文发送兼容**：优先定位实际消息输入框，识别中文发送按钮，并通过新增用户消息确认提交。
3. **避免重复发送**：只有原始草稿仍在输入框内时才尝试 Enter 后备操作。
4. **只提取本次助手回答**：不再把首页导航、历史回答或思考占位文字当成返回值；未完成的回答超时会报错。
5. **增加选中状态证据**：保留原有 MCP 参数和返回字段，新增可选的 `verifiedModelLabel`。该字段表示网页控件的选中标签，不是服务端内部模型 ID。

修复集中在 `src/tools/proTools.ts`，回归测试位于 `src/tests/proBrowser.test.ts`。旧的 mock 和 AppleScript 后端没有被整体改写；真实验证使用的是默认的 `playwright-chrome` 后端。

## 安装

需要 Node.js 20+、pnpm、Google Chrome，以及可以使用网页 Pro 模式的 ChatGPT 账号。

```bash
git clone https://github.com/qigang47/codex-gptpro-zh.git
cd codex-gptpro-zh
pnpm install --frozen-lockfile
pnpm run build
```

将 `.env.example` 复制为仅保存在本机的 `.env`，设置以下选项：

```dotenv
MCP_PRO_MODEL_LABEL=Pro
```

原项目源码中的默认标签仍为日文 `Pro 拡張`；对于本版实测的中文界面，需要上述本机配置，或在单次 `run_pro_prompt` 调用中传入 `modelLabel: "Pro"`。不要把真实 `.env` 提交到仓库。

配置并启动：

```bash
pnpm run codex:configure
pnpm start
```

`codex:configure` 会修改当前用户的 Codex 配置。首次配置前应备份已有 `config.toml`。默认连接为：

```toml
[mcp_servers.codex_gptpro]
url = "http://127.0.0.1:8788/mcp-codex"
startup_timeout_sec = 20
tool_timeout_sec = 1200
enabled = true
default_tools_approval_mode = "prompt"
```

在 macOS 上，也可使用项目提供的用户级后台服务：

```bash
pnpm run launchd:install
```

启动后重新加载 Codex 的 MCP 配置。让 Codex 调用 `prepare_pro_browser`，在打开的独立 Chrome 窗口中登录 ChatGPT。不要把密码、验证码或 Cookie 发给代理。

如果后台服务找不到 pnpm，可在本机 `.env` 中将 `PNPM_HOME` 设置为包含 pnpm 可执行文件的目录；不要复制其他机器的用户路径。

## 使用和验证

代码项目首次使用前，先让 Codex 调用 `register_project` 注册该项目；多个项目应在调用时显式使用对应的 `projectId`。

注册之后，可用不含敏感信息的短句测试：

```json
{
  "projectId": "your-registered-project",
  "prompt": "只回复 OK",
  "modelLabel": "Pro",
  "confirmSendToChatGpt": true,
  "keepBrowserOpen": true,
  "save": false
}
```

仓库不会附带登录状态。其他机器需要自行完成账号登录和项目注册。

2026-09-03 在中文 ChatGPT 界面上进行了两次真实 Chrome 测试，均返回纯 `OK`，耗时约 40.8 秒和 46.2 秒；`verifiedModelLabel` 为 `Pro`。这验证的是当时的网页 Pro 模式，不保证未来网页版本或所有账号的表现。

本地检查命令：

```bash
pnpm run build
pnpm run test
pnpm run lint
pnpm run smoke
pnpm run healthcheck
```

验证时全部 35 个测试通过，其中 10 个是新增的浏览器行为回归测试。`smoke` 使用模拟浏览器响应，不能代替真实账号测试；`healthcheck` 要求本地服务已经启动。

## 使用边界

- 这是第三方浏览器自动化，不是 OpenAI 官方 ChatGPT API 集成。
- 默认仅监听 `127.0.0.1`；未配置认证时不要将端口暴露到公网。
- 多个任务复用专用浏览器，应串行调用，不要同时操作相同页面。
- 生成期间不要关闭或刷新专用窗口。本版没有修改或验证关闭后自动恢复机制。
- 发送内容由 `prompt` 决定；传输代码、文件内容或其他非公开资料前，先核对必要性和授权。
- 不要上传 `.env`、项目注册表、`.ai`、`.codex`、Chrome profile、凭据、运行日志或本机配置备份。
- 本仓库不包含任何账号凭据、业务项目源码、个人聊天记录或本机绝对路径。
