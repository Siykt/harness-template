# HT-004 修复 Agent 重复读取上下文和重复 Init

## Requirement

修复 agent 执行过程中重复读取 `CONTEXT-GATE.md`、重复执行 `./init.sh` 的问题。目标不是绕过仓库协议，而是让 `agent.ts` 已经完成的 preflight evidence 成为下游 agent 可复用的事实来源，避免同一次 runner 调用里外两层都完整重跑启动流程。

这个 feature 需要先讨论设计方案，再进入实现。推荐设计方向：

- `agent.ts` 仍负责执行一次 `pwd`、读取 `CONTEXT-GATE.md`、`git log --oneline -5`、`./init.sh`、Layer 1 摘要和 Layer 2 路由。
- 生成的 plan 明确标记这些 preflight evidence 已经由 harness 完成，并要求子 agent 只在证据缺失、失败、过期或用户显式要求时才重跑。
- 引入可审计的 preflight manifest，例如写入计划文件内的 `Preflight Evidence` block，或额外写入 `.harness/tmp/<run-id>/preflight.json`。
- 子 agent 仍可读取必要文件来完成任务，但不应机械重复完整启动循环。

待讨论问题：

- preflight evidence 的有效期按一次 `agent.ts` 调用、一次 dispatcher loop iteration，还是按 run id 绑定？
- `./init.sh` 失败时是否完全阻止启动子 agent，还是允许 reviewer/coder 读取失败证据后修复？
- 为了兼容 AGENTS.md 的硬约束，需要在 prompt 中如何表述“已由 harness 完成”才不会让子 agent 误判为违反协议？

## Table Todo List

| ID | Todo | Acceptance | Status |
| --- | --- | --- | --- |
| `HT-004-T1` | 明确 preflight ownership 设计。 | 文档或实现说明 `agent.ts` 与子 agent 对 `pwd`、`CONTEXT-GATE.md`、`git log`、`./init.sh`、Layer 1 的职责边界。 | `todo` |
| `HT-004-T2` | 让 `agent.ts` 生成可复用 preflight evidence。 | 计划文件或临时 JSON 中包含命令、退出码、摘要输出、生成时间和仓库路径。 | `todo` |
| `HT-004-T3` | 调整 runner prompt，禁止无条件重跑启动流程。 | 子 agent prompt 明确要求复用 harness preflight，只有证据缺失、失败、过期或任务需要时才重跑。 | `todo` |
| `HT-004-T4` | 保留故障修复能力。 | 当 `./init.sh` 失败时，runner 能看到失败证据和日志尾部，并按 blocker 或修复流程处理。 | `todo` |
| `HT-004-T5` | 增加回归测试。 | 测试能证明 plan 包含 preflight evidence，并且 prompt 中没有要求子 agent 无条件再次执行 `./init.sh`。 | `todo` |

## Verification

| Command | Required Result |
| --- | --- |
| `pnpm test` | PASS，覆盖 preflight evidence 生成、prompt 复用约束和失败证据传递。 |
| `pnpm build` | PASS。 |
| `pnpm agent -- --runner coder --task "smoke" --dry-run` | PASS，输出的 plan 中只有 harness preflight 证据，不要求子 agent 无条件重跑 `./init.sh`。 |

## Feature List Consistency

| Field | Expected |
| --- | --- |
| `id` | `HT-004` |
| `status` | `not_started` until implementation begins; then exactly one active feature may become `in_progress` |
| `priority` | `4` |
| `dependsOn` | `[]` |
| `layer2_refs` | `["docs/features/HT-004-run-context-preflight-cache.md"]` |
