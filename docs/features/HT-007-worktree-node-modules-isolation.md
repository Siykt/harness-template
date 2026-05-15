# HT-007 隔离 Runner Worktree 的 node_modules

## Requirement

Runner worktree 不应共享主工作树的 `node_modules`。共享依赖目录会让 `pnpm install` / `./init.sh` 在 worktree 中尝试重置或协调同一份 `node_modules`，可能导致初始化卡死。

创建 runner worktree 时只创建 Git worktree 和 run-scoped `.harness/runs/<run-id>` 目录。依赖安装由 worktree 内的 `./init.sh` 根据 lockfile 自己完成，避免触碰主工作树依赖目录。

## Table Todo List

| ID | Todo | Acceptance | Status |
| --- | --- | --- | --- |
| `HT-007-T1` | 移除 worktree 创建时的 `node_modules` symlink。 | `createRunnerWorktree` 不再把主工作树 `node_modules` 暴露给 runner worktree。 | `done` |
| `HT-007-T2` | 增加回归测试。 | 测试在主工作树存在 `node_modules` 时创建 runner worktree，并断言 worktree 内没有 `node_modules`。 | `done` |
| `HT-007-T3` | 做真实 worktree smoke。 | 临时 git worktree 创建后 `node_modules_exists_before=false`，且 worktree 内 `./init.sh` 能退出 0。 | `done` |

## Verification

| Command | Required Result |
| --- | --- |
| `./init.sh` | PASS，主工作树基础验证仍可用。 |
| `pnpm test` | PASS，覆盖 worktree 不共享 `node_modules` 的回归测试。 |
| `pnpm exec tsc --noEmit` | PASS。 |
| `temporary git worktree + CI=true ./init.sh` | PASS，worktree 内不预置 `node_modules` 且 init 能完成。 |
| `pnpm build` | PASS。 |

## Feature List Consistency

| Field | Expected |
| --- | --- |
| `id` | `HT-007` |
| `status` | `passing` after verification evidence is recorded |
| `priority` | `7` |
| `dependsOn` | `["HT-005"]` |
| `layer2_refs` | `["docs/features/HT-007-worktree-node-modules-isolation.md"]` |
