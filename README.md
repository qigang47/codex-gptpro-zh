# codex-gptpro: call ChatGPT Pro from Codex

> Chinese UI compatibility snapshot: [qigang47/codex-gptpro-zh](https://github.com/qigang47/codex-gptpro-zh).
> Start with the [中文安装与修复说明](README.zh-CN.md) for this version.
> Based on [tomato-ga/codex-gptpro](https://github.com/tomato-ga/codex-gptpro) at commit
> `656d80698758789e6c23b37918372b79c831177e`. The upstream README below is retained for reference;
> its clone URL and Japanese model-label examples refer to the original project.

[日本語](#日本語) | [English](#english)

`codex-gptpro` is a local MCP server that lets Codex ask ChatGPT Web Pro for planning, review, and long-running reasoning, then receive the result back inside Codex.

It is designed for a local, Codex-led workflow. ChatGPT Web does not directly call Codex, and this MCP does not expose arbitrary shell execution, patch application, git commits, git pushes, file deletion, or a remote Codex runner.

Canonical names:

- GitHub repo: `codex-gptpro`
- package name: `codex-gptpro`
- MCP server name: `codex_gptpro`
- Chrome profile: `codex-gptpro`

---

## 日本語

### これは何か

`codex-gptpro` は、Codex から ChatGPT Web の Pro 拡張へpromptを送り、回答をCodexへ返すためのローカルMCPサーバーです。

主な用途は、Codexが実装中にChatGPT Proへ重い計画、設計レビュー、調査、長時間の推論を依頼し、その出力をローカルの `.ai/pro-outputs` に保存して作業に戻すことです。

### アーキテクチャ

```text
Codex
  -> MCP server: codex_gptpro
  -> http://127.0.0.1:8788/mcp-codex
  -> run_pro_prompt
  -> Google Chrome profile: codex-gptpro
  -> ChatGPT Web Pro
  <- Pro output saved under .ai/pro-outputs
```

任意で `/mcp` もありますが、通常の主経路では使いません。CodexからChatGPT Proを呼び出すだけなら、外部公開やCloudflare Tunnelは不要です。

### 必要条件

- Node.js 20+
- pnpm
- Google Chrome
- Codex CLI または Codex IDE

Chromiumや専用Chromeアプリのインストールは不要です。既存のGoogle Chromeアプリに、MCP用profile `codex-gptpro` を作って使います。

### セットアップ

```bash
git clone https://github.com/tomato-ga/codex-gptpro.git
cd codex-gptpro
pnpm install
pnpm build
pnpm run codex:configure
```

開発起動:

```bash
pnpm dev
```

本番寄りのローカル起動:

```bash
pnpm start
```

デフォルトURL:

```text
http://127.0.0.1:8788
```

### Codex設定

`pnpm run codex:configure` は `~/.codex/config.toml` に次のMCP設定を追加します。

```toml
[mcp_servers.codex_gptpro]
url = "http://127.0.0.1:8788/mcp-codex"
startup_timeout_sec = 20
tool_timeout_sec = 1200
enabled = true
default_tools_approval_mode = "prompt"
```

`MCP_CODEX_TOKEN` を設定している場合だけ、次の行も追加されます。

```toml
bearer_token_env_var = "MCP_CODEX_TOKEN"
```

古い `[mcp_servers.webgpt]` がある場合は、`codex:configure` が新しい `codex_gptpro` 設定へ置き換えます。

### 使い方

Codexでこう依頼します。

```text
Use codex_gptpro MCP.
Register the current repository automatically if needed.
Ask ChatGPT Pro to create an implementation plan for the current task.
Save the output and summarize the next steps.
```

初回だけChrome profileのログインが必要な場合があります。

```text
Use codex_gptpro MCP.
Call prepare_pro_browser with keepBrowserOpen: true.
```

開いたChrome profile `codex-gptpro` でChatGPTにログインしてください。その後、`run_pro_prompt` が使えます。

### 主なtool

- `register_project`: 現在のrepoをMCPへ登録
- `list_projects`: 登録済みrepoを一覧
- `repo_tree`: repo構造を安全に取得
- `read_file`: 許可されたtext fileを読む
- `grep_repo`: repo内検索
- `git_diff`: bounded diffを取得
- `pro_browser_status`: Chrome/Pro連携状態を確認
- `prepare_pro_browser`: ChatGPTログイン用にChrome profileを開く
- `run_pro_prompt`: ChatGPT Proへpromptを送り、回答を返す
- `list_tasks`, `read_task`, `claim_task`, `write_result`, `read_result`: `.ai` task handoff
- `run_check`: `typecheck`, `lint`, `test`, `build` のallowlisted scriptだけ実行

### Chrome profile

デフォルト:

```text
MCP_PRO_CHROME_AUTOMATION_USER_DATA_DIR=~/.codex-gptpro/chrome-user-data
MCP_PRO_CHROME_PROFILE_DIRECTORY=codex-gptpro
```

これは既存のGoogle Chromeアプリを使います。Chrome 136+では通常のChrome data directoryに対するremote debuggingが制限されるため、MCP専用のuser data dirを使います。

### 任意の環境変数

`.env` は必須ではありません。必要な場合だけ作成します。

```bash
cp .env.example .env
chmod 600 .env
```

よく使う値:

```bash
MCP_PORT=8788
MCP_CODEX_TOKEN=<long-random-token>
MCP_PUBLIC_PIN=<short-lived-pin>
MCP_PRO_MODEL_LABEL=Pro 拡張
MCP_PRO_CHROME_PROFILE_DIRECTORY=codex-gptpro
```

### セキュリティ

public repoへ入れてはいけないものは `.gitignore` で除外しています。

- `.env`, `.env.*`
- `projects.local.json`
- `.ai/`
- `.codex/`
- `node_modules/`, `dist/`, `coverage/`
- local launchd plist
- Chrome profile data
- local memory files

MCP toolsも意図的に制限しています。

- arbitrary shell executionなし
- patch applicationなし
- file deletionなし
- git commit/pushなし
- direct Codex invocationなし

### 検証

```bash
pnpm build
pnpm test
pnpm lint
pnpm run healthcheck
```

macOSで常駐化する場合:

```bash
pnpm run launchd:install
launchctl print "gui/$(id -u)/local.codex-gptpro"
```

---

## English

### What It Does

`codex-gptpro` is a local MCP server that lets Codex send prompts to ChatGPT Web Pro and receive the answer back in Codex.

The main use case is letting Codex delegate heavyweight planning, design review, research, and long-running reasoning to ChatGPT Pro while keeping implementation and verification local.

### Architecture

```text
Codex
  -> MCP server: codex_gptpro
  -> http://127.0.0.1:8788/mcp-codex
  -> run_pro_prompt
  -> Google Chrome profile: codex-gptpro
  -> ChatGPT Web Pro
  <- Pro output saved under .ai/pro-outputs
```

The optional `/mcp` endpoint exists for safe planner/reviewer tools, but it is not required for the primary workflow. If all you want is Codex calling ChatGPT Pro, you do not need to expose any endpoint publicly.

### Requirements

- Node.js 20+
- pnpm
- Google Chrome
- Codex CLI or Codex IDE

You do not need Chromium or a separate Chrome app. The server uses your existing Google Chrome app with a dedicated Chrome profile named `codex-gptpro`.

### Setup

```bash
git clone https://github.com/tomato-ga/codex-gptpro.git
cd codex-gptpro
pnpm install
pnpm build
pnpm run codex:configure
```

Development server:

```bash
pnpm dev
```

Production-like local server:

```bash
pnpm start
```

Default URL:

```text
http://127.0.0.1:8788
```

### Codex Config

`pnpm run codex:configure` writes this MCP server block to `~/.codex/config.toml`.

```toml
[mcp_servers.codex_gptpro]
url = "http://127.0.0.1:8788/mcp-codex"
startup_timeout_sec = 20
tool_timeout_sec = 1200
enabled = true
default_tools_approval_mode = "prompt"
```

If `MCP_CODEX_TOKEN` is set, it also adds:

```toml
bearer_token_env_var = "MCP_CODEX_TOKEN"
```

If an old `[mcp_servers.webgpt]` block exists, `codex:configure` replaces it with the new `codex_gptpro` server name.

### Usage

Ask Codex:

```text
Use codex_gptpro MCP.
Register the current repository automatically if needed.
Ask ChatGPT Pro to create an implementation plan for the current task.
Save the output and summarize the next steps.
```

On first use, the Chrome profile may need a ChatGPT login:

```text
Use codex_gptpro MCP.
Call prepare_pro_browser with keepBrowserOpen: true.
```

Log in to ChatGPT in the opened `codex-gptpro` Chrome profile. After that, use `run_pro_prompt`.

### Main Tools

- `register_project`: register the current repository
- `list_projects`: list registered repositories
- `repo_tree`: inspect repository structure safely
- `read_file`: read allowed text files
- `grep_repo`: search repository text
- `git_diff`: return bounded diff output
- `pro_browser_status`: check Chrome/Pro automation status
- `prepare_pro_browser`: open the Chrome profile for first-run login
- `run_pro_prompt`: send a prompt to ChatGPT Pro and return the answer
- `list_tasks`, `read_task`, `claim_task`, `write_result`, `read_result`: `.ai` task handoff
- `run_check`: run only allowlisted package scripts: `typecheck`, `lint`, `test`, `build`

### Chrome Profile

Defaults:

```text
MCP_PRO_CHROME_AUTOMATION_USER_DATA_DIR=~/.codex-gptpro/chrome-user-data
MCP_PRO_CHROME_PROFILE_DIRECTORY=codex-gptpro
```

This uses your existing Google Chrome app. Chrome 136+ restricts remote debugging on the default Chrome data directory, so this server uses a dedicated user data directory for MCP automation.

### Optional Environment Variables

`.env` is optional. Create one only when needed.

```bash
cp .env.example .env
chmod 600 .env
```

Common values:

```bash
MCP_PORT=8788
MCP_CODEX_TOKEN=<long-random-token>
MCP_PUBLIC_PIN=<short-lived-pin>
MCP_PRO_MODEL_LABEL=Pro 拡張
MCP_PRO_CHROME_PROFILE_DIRECTORY=codex-gptpro
```

### Security

Local and sensitive files are ignored by default:

- `.env`, `.env.*`
- `projects.local.json`
- `.ai/`
- `.codex/`
- `node_modules/`, `dist/`, `coverage/`
- local launchd plists
- Chrome profile data
- local memory files

The MCP surface is intentionally limited:

- no arbitrary shell execution
- no patch application
- no file deletion
- no git commit/push
- no direct Codex invocation

### Verification

```bash
pnpm build
pnpm test
pnpm lint
pnpm run healthcheck
```

For macOS launchd:

```bash
pnpm run launchd:install
launchctl print "gui/$(id -u)/local.codex-gptpro"
```
