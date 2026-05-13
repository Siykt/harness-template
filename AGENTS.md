# AGENTS.md

你正在一个为长时实现工作设计的仓库中工作。优先保证可靠完成、跨会话连续性和显式验证，而不是表面上的速度。

> **上下文控制说明**：本项目采用**渐进式上下文披露**设计。  
> 硬约束和完整的加载协议见 **`CONTEXT-GATE.md`**（每轮必读）。  
> 不要在 session 开始时大量加载文档，只按 CONTEXT-GATE 的分层协议按需加载。

## 固定工作循环

每轮会话开始时，**严格按此顺序执行**：

1. 运行 `pwd`，确认当前在正确的仓库根目录
2. 读取 **`CONTEXT-GATE.md`**（硬约束 + 上下文加载协议）← **必读**
3. 运行 `git log --oneline -5` 查看最近提交
4. 运行 `./init.sh`
5. 读取 `claude-progress.md`（只读"当前已验证状态"块 + 最近 1 个会话记录）
6. 读取 `feature_list.json`（只读 `{id, title, status, priority}` 字段）
7. 选定唯一 active feature，按 CONTEXT-GATE 路由表加载 Layer 2 专题文档
8. 检查基础 smoke test 或端到端路径是否已经损坏

然后只围绕选定的 feature 工作，直到它被验证通过，或被明确记录为 blocked。

## 规则

- 同一时间只能有一个 active feature
- 没有可运行证据时，不要声称完成
- 不要通过重写功能清单来隐藏未完成工作
- 不要为了"看起来完成"而删除或削弱测试
- 以仓库内文件作为唯一事实来源
- **不得在 CONTEXT-GATE 允许的范围外加载大量文档**（缓解上下文焦虑）

## Harness 文件索引

| 文件 | 读取时机 | 说明 |
|------|---------|------|
| `AGENTS.md` | 每轮开始（本文件） | 工作循环 |
| `CONTEXT-GATE.md` | 每轮开始，紧接本文件 | 硬约束 + 分层加载协议 |
| `claude-progress.md` | Layer 1（会话定向） | 进度日志 |
| `feature_list.json` | Layer 1（会话定向） | 功能状态 |
| `session-handoff.md` | 需要快速上下文交接时 | 跨会话摘要 |
| `init.sh` | 每轮初始化时执行 | 依赖安装 + 基础验证 |
| `clean-state-checklist.md` | 提交前 | 干净状态检查 |
| `evaluator-rubric.md` | feature 验收前 | 自审评分表（正确性/验证/范围/可维护性）|

## 专题文档（Layer 2，按需加载）

> 不要全部加载，只加载与当前 active feature 相关的 1-2 份。具体路由规则见 `CONTEXT-GATE.md`。

- `docs/context/strategy-ref.md` — 策略概览
- `docs/context/module-map.md` — 模块快速参考
- `docs/context/verification-ref.md` — 验证协议
- `docs/context/risk-constraints.md` — 风险约束（高敏感）

## 完成门槛

只有在要求的验证成功且结果被记录后，功能状态才可以切换到 `passing`。

## 结束前

1. 更新 `claude-progress.md` 进度日志
2. 更新 `feature_list.json` 功能状态和 evidence
3. 记录仍然损坏或未验证的内容, 并发出 blocker 警告（如果有）
4. **读取 `evaluator-rubric.md`，对本轮工作逐项评分（0-2），将结论（Accept / Revise / Block）写入 `claude-progress.md` 本轮记录** ← 违反 H11
5. **读取 `clean-state-checklist.md`，逐项执行验证命令，将每项 PASS/FAIL + 证据追加到本轮进度记录末尾** ← 违反 H10
6. pnpm build 通过即可提交 — `pnpm test` 失败不阻断 commit，在 message 中注明即可
7. 给下一轮会话留下干净的重启路径
