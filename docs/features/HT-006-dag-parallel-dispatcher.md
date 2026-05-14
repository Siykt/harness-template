# HT-006 使用 DAG 支持并行执行

## Requirement

使用 DAG 支持并行执行。`feature_list.json` 需要定义 `dependsOn` 依赖树。Dispatcher 扫描队列时找出所有 `status === "not_started"` 且依赖已全部 `passing` 的任务，将这些无前置阻塞的任务放进执行池并发运行。

并发执行必须和 worktree runner 配合，避免多个 agent 共享同一个工作目录或同时写入 `feature_list.json`。状态更新应由 `agent.ts` 在每个 runner 完成后集中处理。

调度规则：

- `dependsOn` 缺省时按空数组处理，保持旧 feature_list 兼容。
- 依赖不存在、依赖成环、依赖 feature 为 `blocked` 时，dispatcher 不应启动受影响 feature，并应输出明确 blocker。
- 同一轮并发池只包含依赖已全部 `passing` 的 `not_started` feature。
- `pending_review` 可以进入 reviewer 池；是否和 coder 池混跑需要在实现前明确策略，默认可以先限制为同一轮只处理一种 runner 类型。

## Table Todo List

| ID | Todo | Acceptance | Status |
| --- | --- | --- | --- |
| `HT-006-T1` | 扩展 feature schema 支持 `dependsOn`。 | `feature_list.json` 可为每个 feature 声明依赖数组；缺省时兼容为 `[]`。 | `todo` |
| `HT-006-T2` | 实现 DAG 校验。 | 检测缺失依赖、循环依赖、blocked 依赖，并给出确定性错误或 blocker 输出。 | `todo` |
| `HT-006-T3` | 扫描所有可运行 feature。 | Dispatcher 能返回所有 `not_started` 且依赖全 passing 的任务，而不是只选优先级最高的一个。 | `todo` |
| `HT-006-T4` | 实现并发池。 | 支持配置最大并发数；每个 feature 使用独立 worktree/run id；失败不会导致其他已启动任务写坏状态。 | `todo` |
| `HT-006-T5` | 集中汇总结果。 | 所有 runner 结束后，`agent.ts` 汇总每个 result JSON，按 feature 更新状态、evidence、blocker 和进度记录。 | `todo` |
| `HT-006-T6` | 增加 DAG 调度测试。 | 测试覆盖并行候选选择、依赖未 passing、blocked 依赖、缺失依赖、循环依赖和最大并发限制。 | `todo` |

## Verification

| Command | Required Result |
| --- | --- |
| `pnpm test` | PASS，覆盖 DAG 解析、ready pool 选择、错误依赖处理和并发限制。 |
| `pnpm build` | PASS。 |
| `pnpm agent -- --runner dispatcher --dry-run` | PASS，输出 ready pool、每个 feature 的依赖状态和计划中的并发执行策略。 |

## Feature List Consistency

| Field | Expected |
| --- | --- |
| `id` | `HT-006` |
| `status` | `not_started` until implementation begins; then exactly one active feature may become `in_progress` or a dispatcher-managed parallel run may own multiple isolated worktrees without direct child-agent status writes |
| `priority` | `6` |
| `dependsOn` | `["HT-005"]` |
| `layer2_refs` | `["docs/features/HT-006-dag-parallel-dispatcher.md"]` |
