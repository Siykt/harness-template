# 干净状态检查清单

> 逐项执行下方验证命令，将每项 **PASS / FAIL + 证据（命令输出或说明）** 追加到本轮进度日志后才可结束 session。  
> 不得仅声称"已确认"——没有文字证据视为未执行。

- [ ] 标准启动路径仍然可用  
  → `./init.sh` 无报错（粘贴最后 3 行）
- [ ] `pnpm build` 通过  
  → 粘贴 build 输出末行（含耗时或 `Build succeeded`）
- [ ] 本轮变更已 git commit  
  → `git log --oneline -1` 输出（粘贴）；test 失败须在 message 中注明
- [ ] 当前进度已记录到进度日志  
  → `claude-progress.md` 本轮记录已写入，含"修改了什么、为什么"
- [ ] 功能状态真实反映了 passing 和未验证的边界  
  → `feature_list.json` 的 status 字段已更新
- [ ] 没有任何半成品步骤处于未记录状态  
  → 未完成项已在进度日志标记 blocked / pending
- [ ] 下一轮会话无需人工修复即可继续  
  → 进度日志末尾有明确的"下一步"指引