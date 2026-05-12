# harness-template

`harness-template` 是一个面向长时 Codex 实现工作的开源仓库模板。它把功能选择、上下文加载、验证证据、交接记录和提交纪律都放进仓库文件中，保证一次会话中断后，下一轮仍能从明确状态继续。

这个模板刻意保持轻量：核心价值不在应用脚手架，而在根目录协议文件和 `agent` 启动器。

## 核心能力

- 用 `AGENTS.md` 和 `CONTEXT-GATE.md` 固化每轮会话协议。
- 用 `feature_list.json` 跟踪功能队列，并约束同一时间只有一个 active feature。
- 用 `claude-progress.md` 记录已验证状态、会话日志、blocker 和重启路径。
- 提供 dispatcher / coder / reviewer 三种 Codex runner，自动生成有边界的执行 prompt。
- 通过 `init.sh`、`pnpm test`、`pnpm build` 留下可运行验证证据。
- 通过 `evaluator-rubric.md` 和 `clean-state-checklist.md` 做结束前自审。

## 目录结构

| 路径 | 作用 |
| --- | --- |
| `AGENTS.md` | 每轮会话的主工作协议。 |
| `CONTEXT-GATE.md` | 渐进式上下文加载规则和硬约束。 |
| `feature_list.json` | 功能队列、状态、优先级和 evidence。 |
| `claude-progress.md` | 当前已验证状态、会话日志、风险和下一步。 |
| `agent.ts` | TypeScript 版 Codex 启动器和 dispatcher。 |
| `agent/` | Python 版启动器实现。 |
| `init.sh` | 依赖同步和基础验证入口。 |
| `clean-state-checklist.md` | session 结束前的干净状态检查。 |
| `evaluator-rubric.md` | 功能验收前的自评表。 |
| `src/`, `tests/` | 最小占位应用和 smoke tests。 |

## 环境要求

- Node.js 和 `pnpm`。
- Codex CLI，默认可执行名为 `codex`；也可以通过 `--codex-bin` 指定路径。
- 如果使用 Python 启动器，需要 Python 3.11+。

当前仓库在 `package.json` 中声明使用 `pnpm@10.28.2`。

## 快速开始

安装依赖并运行基础验证：

```bash
./init.sh
```

单独运行测试：

```bash
pnpm test
```

构建项目：

```bash
pnpm build
```

查看 TypeScript 启动器生成的 Codex prompt 和命令，但不真正启动 Codex：

```bash
pnpm agent -- --task "Implement the next feature" --dry-run
```

查看 dispatcher 的自动分派结果：

```bash
pnpm agent:dispatch -- --dry-run
```

## 功能状态流转

功能以 `feature_list.json` 为事实来源，常见状态流转如下：

```text
not_started -> in_progress -> pending_review -> passing
```

如果当前功能无法继续，使用 `blocked`，并在 `claude-progress.md` 写清楚原因、证据和下一轮重启方式。

仓库协议要求同一时间只能有一个 active feature。修改生产代码或项目文档前，应先选择或登记本轮对应的 feature，并让状态与真实证据保持一致。

## Agent 启动器

启动器会读取协议文件、运行 preflight、选择 feature 上下文、在 `docs/plans` 下写入执行计划，然后调用 Codex。

常用命令：

```bash
pnpm agent -- --task "Add README usage docs"
pnpm agent:coder -- --feature F001 --task "Implement the selected feature"
pnpm agent:reviewer -- --feature F001
pnpm agent:dispatch -- --dry-run
pnpm agent:loop -- --max-loop-iterations 3
```

常用参数：

| 参数 | 说明 |
| --- | --- |
| `--feature`, `-f` | 指定 feature id。 |
| `--task`, `-t` | 指定本轮任务。 |
| `--runner` | 选择 `coder`、`reviewer` 或 `dispatcher`。 |
| `--layer2-ref` | 额外加载一份 Layer 2 上下文文档。 |
| `--skip-init` | 跳过 `./init.sh` preflight。 |
| `--dry-run` | 只写 plan 并打印 Codex 命令，不启动 Codex。 |
| `--continue`, `-c` | 继续最近一次 Codex exec session。 |
| `--resume`, `-r` | 继续指定 Codex exec session。 |
| `--codex-bin` | 指定 Codex 可执行文件。 |

Python 启动器也提供同样的工作流：

```bash
python3 -m agent --task "Implement the next feature" --dry-run
```

## 上下文加载协议

每轮 session 从最少必要上下文开始：

1. 用 `pwd` 确认仓库根目录。
2. 读取 `CONTEXT-GATE.md`。
3. 用 `git log --oneline -5` 查看最近提交。
4. 运行 `./init.sh`。
5. 读取 `claude-progress.md` 中的当前已验证状态和最近一次 session。
6. 只读取 `feature_list.json` 中每个 feature 的 `{id, title, status, priority}`。
7. 只加载当前 feature 路由到的 Layer 2 文档。
8. 检查基础 smoke path 是否仍然可用。

这个流程用于避免一次性加载过多无关上下文，也避免在没有验证证据时把功能标记为完成。

## 验证和收尾

完成功能前，运行任务要求的检查和仓库结束门槛。通常至少包括：

```bash
pnpm test
pnpm build
```

结束 session 前：

- 更新 `claude-progress.md`，记录改了什么、为什么、验证输出、风险和下一步。
- 更新 `feature_list.json` 的 status 和 evidence。
- 读取并应用 `evaluator-rubric.md`。
- 读取并应用 `clean-state-checklist.md`。
- `pnpm build` 通过后提交；如果 `pnpm test` 失败，仍可提交，但必须在 commit message 和进度日志中注明。

## 作为模板使用

- 让 `AGENTS.md` 和 `CONTEXT-GATE.md` 保持简短、明确、权威。
- 只为项目真正需要的主题增加 Layer 2 文档。
- 把 `feature_list.json` 和 `claude-progress.md` 当作跨会话连续性的事实来源。
- 不要通过删除测试、削弱验证或改写清单来制造“完成”的假象。
