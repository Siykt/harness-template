# Harness Template V0.1 Features

本文件登记 V0.1 的原子 feature 边界。每个 feature 的实现必须继续遵守 `CONTEXT-GATE.md`：同一时间只激活一个 feature，验证通过并记录 evidence 后才能进入 `passing`。

## Feature Queue

| Feature ID | Title | Status | Priority | Layer 2 Ref | Scope |
| --- | --- | --- | --- | --- | --- |
| `HT-001` | 拆分 agent bin 与 agent provider 命名 | `not_started` | 1 | `docs/features/HT-001-agent-bin-split.md` | 模块化拆分 agent provider，不再在代码中把 Codex 作为唯一 bin 命名；本期保留基础 codex 能力。 |
| `HT-002` | 添加 feature agent | `not_started` | 2 | `docs/features/HT-002-feature-agent.md` | 协助编写 atomic features，并校验 docs/features todo table 与 feature_list 一致。 |
| `HT-003` | 补充 GitHub Actions e2e 验证 | `not_started` | 3 | `docs/features/HT-003-e2e-github-action.md` | 为 agent 拆分和 feature agent 设计增加模块化 e2e action 验证。 |

## Consistency Checklist

| Check | Expected |
| --- | --- |
| `feature_list.json` 包含 `HT-001` | status=`not_started`，priority=`1`，layer2_refs 指向 `docs/features/HT-001-agent-bin-split.md` |
| `feature_list.json` 包含 `HT-002` | status=`not_started`，priority=`2`，layer2_refs 指向 `docs/features/HT-002-feature-agent.md` |
| `feature_list.json` 包含 `HT-003` | status=`not_started`，priority=`3`，layer2_refs 指向 `docs/features/HT-003-e2e-github-action.md` |
| 每个 feature 文档包含需求和 table todo list | 使用者可以直接按 todo table 推进实现与验收 |

