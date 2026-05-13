# HT-001 拆分 Agent Bin 与 Agent Provider 命名

## Requirement

当前 agent 启动器不应强制使用 Codex，也不应在通用 agent 代码中把 Codex bin 作为唯一命名。本 feature 需要把 agent provider / bin 选择模块化，为以下 agent 留出清晰扩展点：

| Agent | V0.1 Expectation |
| --- | --- |
| `codex` | 本期实现基础能力，保持现有 dry-run、runner、dispatcher、plan 输出和 exec 调用路径可用。 |
| `claude` | 仅登记为受支持 provider，不要求实现完整执行能力。 |
| `openharness` | 仅登记为受支持 provider，不要求实现完整执行能力。 |
| `kimi` | 仅登记为受支持 provider，不要求实现完整执行能力。 |
| `gemini` | 仅登记为受支持 provider，不要求实现完整执行能力。 |

## Table Todo List

| ID | Todo | Acceptance | Status |
| --- | --- | --- | --- |
| `HT-001-T1` | 定义 agent provider 枚举或 registry，包含 `codex`、`claude`、`openharness`、`kimi`、`gemini`。 | TypeScript 与 Python 启动器可读取同一语义的 provider 列表；测试覆盖支持列表。 | `done` |
| `HT-001-T2` | 将通用 CLI 参数从 `--codex-bin` 迁移或扩展为 provider-neutral 命名。 | 新参数不使用 Codex 专属命名；兼容旧参数时必须标记为 codex legacy alias。 | `done` |
| `HT-001-T3` | 把 agent 命令构建逻辑拆成 provider 模块。 | `codex` 模块负责当前 Codex exec 命令；其他 provider 有明确 unsupported/stub 行为。 | `done` |
| `HT-001-T4` | 确保通用代码中的变量、类型、错误信息不再把 Codex 当作唯一 agent。 | `rg "codexBin|--codex-bin|Codex"` 的剩余结果仅出现在 codex provider、文档兼容说明或历史进度中。 | `done` |
| `HT-001-T5` | 保持现有 codex dry-run、dispatcher 和 plan 输出路径可用。 | `pnpm test`、`pnpm build` 通过；新增/更新测试覆盖 codex 基础路径。 | `done` |

## Verification

| Command | Required Result |
| --- | --- |
| `pnpm test` | PASS，包含 provider registry / codex command path 测试。 |
| `pnpm build` | PASS。 |
| `pnpm agent -- --task "smoke" --dry-run` | PASS，输出 provider-neutral plan，默认 provider 仍可调用 codex 基础能力。 |

## Feature List Consistency

| Field | Expected |
| --- | --- |
| `id` | `HT-001` |
| `status` | `not_started` until implementation begins; then exactly one active feature may become `in_progress` |
| `priority` | `1` |
| `layer2_refs` | `["docs/features/HT-001-agent-bin-split.md"]` |
