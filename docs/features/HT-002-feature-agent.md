# HT-002 添加 Feature Agent

## Requirement

新增 feature agent，用于协助使用者编写 atomic features。它必须把需求文档写入 `docs/features`，并同步登记到 `feature_list.json`，同时设置合理的状态、优先级和 `layer2_refs`。

Feature agent 生成的 feature 文档必须把自然语言需求与 table todo list 结合，便于后续 agent 逐项实现、验证和验收。

如果目标项目是前端项目，feature agent 必须要求使用方提供 Figma MCP 或设计稿原件。该要求用于设计归档，避免后续修改时因为没有原始设计来源而漂移。

提交要求：feature agent 创建 feature 规格或清单变更时，只能使用 `chore` 类型提交。

## Table Todo List

| ID | Todo | Acceptance | Status |
| --- | --- | --- | --- |
| `HT-002-T1` | 增加 `feature` runner / agent 入口。 | CLI 能选择 feature agent，并生成面向 atomic feature 编写的 prompt 或 dry-run 输出。 | `done` |
| `HT-002-T2` | 让 feature agent 写入 `docs/features/<feature-id>.md`。 | 文档包含需求、table todo list、验证要求和 feature_list consistency 区块。 | `done` |
| `HT-002-T3` | 让 feature agent 同步更新 `feature_list.json`。 | 新 feature 含 `id`、`title`、`status`、`priority`、`layer2_refs`，且 `layer2_refs` 指向对应 feature 文档。 | `done` |
| `HT-002-T4` | 校验 table todo list 与 `feature_list.json` 的一致性。 | 至少校验 feature id、状态、优先级、layer2_refs；不一致时阻止 passing 或给出明确 blocker。 | `done` |
| `HT-002-T5` | 强制 feature agent 的提交类型为 `chore`。 | 生成的提交建议或自动提交路径只允许 `chore:` 前缀；测试覆盖非 chore 被拒绝。 | `done` |
| `HT-002-T6` | 前端项目要求设计源归档。 | 检测或声明为前端项目时，feature spec 必须记录 Figma MCP 链接或设计稿原件路径；缺失时标记 blocker。 | `done` |

## Verification

| Command | Required Result |
| --- | --- |
| `pnpm test` | PASS，覆盖 feature spec 生成、feature_list 同步、一致性检查和 chore commit 约束。 |
| `pnpm build` | PASS。 |
| `pnpm agent -- --runner feature --task "Draft an atomic feature" --dry-run` | PASS，输出包含 docs/features 写入、feature_list 更新和一致性检查要求。 |

## Feature List Consistency

| Field | Expected |
| --- | --- |
| `id` | `HT-002` |
| `status` | `not_started` until implementation begins; then exactly one active feature may become `in_progress` |
| `priority` | `2` |
| `layer2_refs` | `["docs/features/HT-002-feature-agent.md"]` |
