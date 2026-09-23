# 07: 进度与取消（Cell 粒度）

**What to build:** 运行中的压测显示逐 Cell 进度；用户可以取消，已完成 Cell 的结果保留。

**Blocked by:** 04

**Status:** open

- [ ] 进度以 **Cell** 为粒度，显示当前 Cell（如"正在跑第 3/8 个 Cell：prefill-1k-128, 并发=16"），文案带档位的值而不只是序号
- [ ] 不做请求粒度的实时曲线——单点只跑几十秒，实时数字没有决策价值
- [ ] 取消通过杀掉**子进程组**实现；Cell 置为 cancelled，**已完成 Cell 的结果保留**
- [ ] 子进程已死而 Cell 仍停留在 running 的僵死状态不会出现（启动时 reconcile）
- [ ] 取消一个未在运行的 Cell → 409

## 沿用自 Run 实现的教训

- **终态写入用 SQL 条件写入**（`UPDATE ... WHERE status NOT IN ('completed','failed','cancelled')`），消除取消与监督线程之间的 TOCTOU——判定发生在数据库里，不在两个 Python 线程之间。
- **取消路径上后端接管子进程拥有的列**（子进程已死，只剩一个写入者）。
