# HT-003 补充 GitHub Actions E2E 验证

## Requirement

新增 GitHub Actions e2e 验证，用来验证 agent 拆分和 feature agent 的设计。实现必须保持模块化，避免引入过多额外依赖。

Action 应优先复用仓库已有 Node / pnpm / Vitest / TypeScript 工具链；除非 feature 验证必须，不应增加重量级外部服务或运行时。

## Table Todo List

| ID | Todo | Acceptance | Status |
| --- | --- | --- | --- |
| `HT-003-T1` | 新增 e2e workflow。 | `.github/workflows/e2e.yml` 或等价文件在 push / pull_request 时运行。 | `todo` |
| `HT-003-T2` | 抽出可本地运行的 e2e 脚本。 | GitHub Action 调用仓库脚本，而不是在 YAML 中堆叠复杂逻辑。 | `todo` |
| `HT-003-T3` | 验证 agent provider 拆分的 codex 基础路径。 | e2e dry-run 能证明默认 provider 和 codex provider 仍可生成计划与命令。 | `todo` |
| `HT-003-T4` | 验证 feature agent 设计路径。 | e2e 能检查 feature agent dry-run 或 fixture 输出中包含 docs/features 与 feature_list 一致性要求。 | `todo` |
| `HT-003-T5` | 控制依赖规模。 | 不引入 Playwright、Docker 服务或外部 API；若必须引入新依赖，需在 feature evidence 说明原因。 | `todo` |

## Verification

| Command | Required Result |
| --- | --- |
| `pnpm test` | PASS。 |
| `pnpm build` | PASS。 |
| `pnpm e2e` | PASS，覆盖 agent 拆分和 feature agent 的关键 dry-run 路径。 |

## Feature List Consistency

| Field | Expected |
| --- | --- |
| `id` | `HT-003` |
| `status` | `not_started` until implementation begins; then exactly one active feature may become `in_progress` |
| `priority` | `3` |
| `layer2_refs` | `["docs/features/HT-003-e2e-github-action.md"]` |

