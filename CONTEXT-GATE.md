# CONTEXT-GATE

> **这是 agent 上下文的守门文件。**  
> 遵循**渐进式披露**原则：先读最少量必要上下文，只在无法回答问题时才升级到下一层。

---

## 一、硬约束（不可覆盖，每个 agent 必须遵守）

### 1.1 绝对禁止

| # | 禁止行为 |
|---|---------|
| H1 | 同一 session 同时激活超过 1 个 feature |
| H2 | 未运行验证即将 feature 标记为 `passing` |
| H3 | 修改当前 active feature 范围之外的生产代码 |
| H4 | 删除或弱化已通过的测试（除非测试本身逻辑错误） |
| H5 | 删除/覆盖 `claude-progress.md`、`feature_list.json`、`session-handoff.md` |
| H6 | 在未读 Layer 1 的情况下修改任何代码 |
| H7 | 在 session 结束前，不更新 `claude-progress.md` 和 `feature_list.json` |
| H8 | `pnpm build` 通过后，不在 session 结束前执行 git commit（`pnpm test` 失败**不阻断**提交，但必须在 commit message 中注明） |
| H9 | session 结束前，未将 `clean-state-checklist.md` 每项检查结果（PASS/FAIL + 证据）以文字写入 `claude-progress.md` 本轮记录 |
| H10 | 将 feature 标记为 `passing` 前，未按 `evaluator-rubric.md` 完成逐项评分并将结论（Accept / Revise / Block）写入本轮进度记录 |

### 1.2 强制要求

| # | 必须做 |
|---|--------|
| R1 | session 开始按 **Layer 0 → Layer 1** 顺序加载上下文 |
| R2 | 知道当前 active feature 的 id 后，才可动代码 |
| R3 | 每次修改后，在进度日志记录"修改了什么文件、为什么" |
| R4 | 修复 blocker 前，先在进度日志写下 blocker 描述 |
| R5 | 跨策略问题（如共用服务）升级 Layer 前，先在进度里注明原因 |

---

## 二、渐进式上下文加载协议

### Layer 0 — 必读（每轮 session 开始）

```
AGENTS.md          ← 工作循环规则
CONTEXT-GATE.md    ← 本文件（硬约束 + 路由）
```

**读完即可运行 `git log --oneline -5` 和 `./init.sh`，确认仓库状态。**

---

### Layer 1 — 会话定向（确认工作方向）

```
claude-progress.md          ← 只读"当前已验证状态"块 + 最近 1 个会话记录
feature_list.json           ← 只读每个 feature 的 {id, title, status, priority}
                               跳过 evidence[] 和长 notes 字段
```

读完后选定 **唯一** 的 active feature，才可进入 Layer 2。

---

### Layer 2 — 专题按需（根据任务类型按需加载）

根据下方路由表选择对应专题文档。

| 任务类型 | 加载哪份文档 |
|---------|------------|
| - | - |

---

### Layer 3 — 深度文档（仅在 Layer 2 无法解答问题时读取）

> **触发条件**：Layer 2 文档不足以理解结构或接口，且已在进度日志注明原因。

```
docs/ARCHITECTURE.md              ← 完整系统架构
```

**不得将 Layer 3 全量读入。按需读取单个文件。**

### Wiki — 外部参考资料


## 三、范围锁（Scope Lock）

以下目录/文件在没有明确 feature 指向时**只读**：

---

## 四、快速状态检查（任何时刻均可执行）

```bash
# 查看当前仓库 + active feature
git log --oneline -5
cat feature_list.json | python3 -c "import sys,json; [print(f['id'], f['status'], f['title']) for f in json.load(sys.stdin)['features']]"
```
