# Codex to ChatGPT Pro Extension Workflow

This is the primary workflow when Codex needs ChatGPT Web `Pro 拡張` to produce a high-effort implementation plan.

## Boundary

Codex drives the workflow by calling the `codex_gptpro` MCP server. ChatGPT Web does not call Codex directly.

```text
Codex
  -> call codex-gptpro MCP prepare_pro_browser when first-run login is needed
  -> call codex-gptpro MCP run_pro_prompt
  -> MCP opens ChatGPT Web in Chrome
  -> MCP verifies/selects Pro 拡張
  -> MCP sends a bounded planning prompt
  <- MCP captures Pro output
  -> MCP saves output under .ai/pro-outputs
  -> validate and implement locally
```

`run_pro_prompt` is the core Pro planning tool. Repo inspection, task/result queue, diffs, and checks remain available through the same MCP server.

## Prompt Template

```text
あなたはChatGPT Pro拡張として、Codex実装者に渡す計画を作る役割です。

目的: <Codexが実装する目的>
前提: ChatGPT Webから直接Codexを呼ぶ必要はない。MCPは必要なら共有作業台/タスクキューに限定する。

リポジトリ文脈:
- repo_root: <path>
- relevant files: <paths only>
- current issue/error summary: <short bounded summary>
- constraints: <security and scope constraints>

出力要件:
- 日本語
- 具体的な実装手順を5〜8項目
- セキュリティ境界と失敗時の扱い
- Codexが受け取った後に保存すべき成果物パス案
- 最初の行を PRO_PLAN_START、最後の行を PRO_PLAN_END にする
- 余計な前置きは不要
```

## Capture Requirements

Codex should treat the Pro response as received only when all of these are true:

- The answer came back from the `run_pro_prompt` MCP tool.
- The MCP response reports model label `Pro 拡張`.
- The response contains `PRO_PLAN_START` and `PRO_PLAN_END`.
- The extracted assistant response is saved under `.ai/pro-outputs/`.
- Secrets, tokens, cookies, `.env` contents, and private keys were not sent to ChatGPT.
- Codex compares the plan with current repo state before implementation.

## Suggested Artifact Paths

```text
.ai/pro-outputs/PRO-YYYYMMDD-HHMMSS-<slug>.md
.codex/pro-plan/requests/<task_id>.json
.codex/pro-plan/responses/<task_id>.md
.codex/pro-plan/validated/<task_id>.plan.md
docs/implementation/<task_id>/PRO_PLAN.md
docs/implementation/<task_id>/IMPLEMENTATION_NOTES.md
```

## Failure Handling

- If Pro is still generating, `run_pro_prompt` waits and polls. Pro runs can take several minutes.
- If the `codex-gptpro` Chrome profile is not logged in, call `prepare_pro_browser`, log in once in the opened Chrome window, then rerun `run_pro_prompt`.
- Chrome 136+ ignores CDP for the default Chrome data directory, so the default backend uses `~/.codex-gptpro/chrome-user-data` and `--profile-directory=codex-gptpro`.
- If `MCP_PRO_USE_SYSTEM_CHROME_PROFILE=true` is set and regular Chrome is already running without CDP, call `prepare_pro_browser` or `run_pro_prompt` with `allowChromeRestart: true` only when it is acceptable to quit and relaunch Google Chrome.
- If polite quit is blocked and closing Chrome is still acceptable, add `forceChromeRestart: true`; this sends SIGTERM to Google Chrome but does not use SIGKILL.
- If there is no start/end marker, ask Pro once to reformat the same answer.
- If the response includes unsafe instructions, do not implement. Save it under `.codex/pro-plan/errors/`.
- If browser automation fails, call `pro_browser_status`, keep the task open, and report the missing Chrome/Automation permission.
- Do not start implementation from an empty or partial Pro plan.

## Smoke Test Expectation

In a successful smoke test, Codex calls `run_pro_prompt`, the MCP server selects ChatGPT Web `Pro 拡張`, sends the planning prompt, waits for the generated answer, extracts the assistant response, and saves it to a bounded local artifact such as:

```text
.ai/pro-outputs/PRO-YYYYMMDD-HHMMSS-<slug>.md
```
