# HT-008 修复 Dispatcher 并发 Finalize 竞争

## Requirement

Dispatcher 并行执行多个 ready feature 时，每个 runner 可以在独立 worktree 中并发运行 provider，但主工作树里的 `feature_list.json`、`claude-progress.md` 和 patch 回放必须由 dispatcher 串行汇总。

旧逻辑让每个并发 `runHarness()` 在 provider 结束后直接调用 `finalizeRunnerResult()`，会导致多个 runner 同时写主工作树状态文件，破坏并行调度的可靠性。

## Table Todo List

| ID | Todo | Acceptance | Status |
| --- | --- | --- | --- |
| `HT-008-T1` | 拆分 runner 执行和结果汇总。 | `runHarness` 可只启动 worktree/provider 并返回 worktree/result 元数据，不立即 finalize。 | `done` |
| `HT-008-T2` | Dispatcher 并发执行、串行汇总。 | 非 dry-run dispatcher 使用 `Promise.all` 并发执行 runner，所有 provider 成功后按 pool 顺序调用 `finalizeRunnerResult`。 | `done` |
| `HT-008-T3` | 修复 loop guard。 | dispatcher loop 检查本轮所有 decision 的状态变化，而不是只检查第一个 feature。 | `done` |
| `HT-008-T4` | 避免 dispatcher 子 runner 重复 init。 | dispatcher 每轮先做一次主工作树 `./init.sh` preflight，子 runner 使用 `skipInit: true`，避免并发 init 竞争。 | `done` |

## Verification

| Command | Required Result |
| --- | --- |
| `./init.sh` | PASS。 |
| `pnpm exec tsc --noEmit` | PASS。 |
| `pnpm test` | PASS。 |
| `pnpm agent -- --runner dispatcher --dry-run --max-concurrency 3` | PASS，当前无 ready work 时干净退出。 |
| `pnpm build` | PASS。 |

## Feature List Consistency

| Field | Expected |
| --- | --- |
| `id` | `HT-008` |
| `status` | `passing` after verification evidence is recorded |
| `priority` | `8` |
| `dependsOn` | `["HT-006"]` |
| `layer2_refs` | `["docs/features/HT-008-dispatcher-parallel-finalization.md"]` |
