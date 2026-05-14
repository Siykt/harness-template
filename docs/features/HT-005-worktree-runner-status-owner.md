# HT-005 使用 Git Worktree 执行 Agent Runner 并集中状态更新

## Requirement

使用 git worktree 执行 agent runner。Dispatcher 启动 coder/reviewer 时，应为每个 feature 创建隔离工作树，避免多个 agent 在同一个 checkout 中互相污染文件状态。

同时禁止子 agent 直接更新 `feature_list.json` 中的 feature 状态。子 agent 只能输出临时变更指导和验证证据；运行结束后由 `agent.ts` 读取稳定结果并统一实现状态更新。如果无法稳定控制 agent 最终输出，可以使用临时 JSON 文件作为 agent 和 dispatcher 的交接格式。

推荐交接格式：`.harness/runs/<run-id>/result.json`，由子 agent 写入建议状态、修改摘要、验证命令、失败原因和下一步；`agent.ts` 校验 JSON schema 后再修改 `feature_list.json` 和 `claude-progress.md`。

## Table Todo List

| ID | Todo | Acceptance | Status |
| --- | --- | --- | --- |
| `HT-005-T1` | 为每次 runner 调用创建 git worktree。 | `agent.ts` 能基于 feature id / run id 创建独立 worktree，并在 plan 中使用该 worktree 作为执行 cwd。 | `done` |
| `HT-005-T2` | 定义 worktree 生命周期。 | 成功、失败、blocked、dry-run 下的保留/清理策略明确，并记录 worktree 路径。 | `done` |
| `HT-005-T3` | 禁止子 agent 直接改 feature 状态。 | runner prompt 要求子 agent 不修改 `feature_list.json.status`，只输出临时结果指导；测试覆盖该约束。 | `done` |
| `HT-005-T4` | 实现临时结果 JSON 协议。 | 子 agent 可写 `.harness/runs/<run-id>/result.json`；字段包含 feature id、recommendedStatus、evidence、changedFiles、blocker、notes。 | `done` |
| `HT-005-T5` | 由 `agent.ts` 统一落库状态。 | runner 结束后，`agent.ts` 校验 result JSON，再更新主工作树的 `feature_list.json` 和必要进度记录。 | `done` |
| `HT-005-T6` | 处理 merge 或 patch 回写策略。 | 实现或明确如何将 worktree 中的代码变更带回主工作树，冲突时记录 blocker 而不是静默覆盖。 | `done` |
| `HT-005-T7` | 增加 dry-run 和单测覆盖。 | dry-run 不创建永久 worktree；测试覆盖 worktree 命名、结果 JSON 校验和状态 owner 约束。 | `done` |

## Verification

| Command | Required Result |
| --- | --- |
| `pnpm test` | PASS，覆盖 worktree 创建计划、result JSON schema、子 agent 状态写入禁令和 `agent.ts` 状态更新路径。 |
| `pnpm build` | PASS。 |
| `pnpm agent -- --runner dispatcher --dry-run` | PASS，输出包含将使用 worktree、result JSON 路径和由 `agent.ts` 统一更新状态的说明。 |

## Feature List Consistency

| Field | Expected |
| --- | --- |
| `id` | `HT-005` |
| `status` | `not_started` until implementation begins; then exactly one active feature may become `in_progress` |
| `priority` | `5` |
| `dependsOn` | `[]` |
| `layer2_refs` | `["docs/features/HT-005-worktree-runner-status-owner.md"]` |
