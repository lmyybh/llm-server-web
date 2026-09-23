# 04: Cell 数据模型与单点执行链路（重构）

**What to build:** 按 ADR-0001 把压测数据模型从 Run/Measurement/level_result 推倒重建为 **Workload（全局库）+ Cell**，并跑通"配置一个 Cell → 点【重跑】→ 子进程执行 → 页面看到结果"的完整闭环。

**Blocked by:** 03

**Status:** open

- [ ] `workload` 表全局化：独立于 Model/Deployment；`kind`（synthetic|dataset）恰好二选一（合成必填 input/output tokens，数据集必填数据集名）；内容创建后不可变（仅名称/备注可改）；被 Cell 引用时删除返回 409
- [ ] `cell` 表落地：`(deployment_id, workload_id, mode, level)` 唯一约束；`num_requests` 可改且**不在唯一键内**；结果列（分位数、吞吐、直方图、finish reasons）直接挂在 cell 上，重跑整体覆盖
- [ ] `run` / `measurement` / `level_result` 表删除；数据库推倒重建，**不写迁移**（ADR-0001）
- [ ] 后端 spawn 一次性子进程执行**单个 Cell**；写入所有权分离沿用：后端只写状态字段，子进程只写结果/进度/执行快照，不写同一列
- [ ] 固定值写死在执行路径：**warmup=5、每次执行前恒 flush（无开关）、seed 内部固定不暴露**
- [ ] 执行时冻结**执行快照**（Workload 形状、mode、level、num_requests、固定值、执行器标识、负载发生器版本）存于 cell
- [ ] 合成 Workload 的 input/output tokens 超过所属 Deployment 的 `synthetic_input_limit` 时，创建 Cell 即 422
- [ ] 对运行中的 Cell 再次点开始 → **409 拒绝**
- [ ] 子进程异常退出时 Cell 置为 failed 并记录错误，不停留在 running
- [ ] SQLite WAL 模式保持开启

## 沿用自 Run 实现的教训

（原 Run 实现已完成并验证，实体模型被 ADR-0001 取代；以下教训仍然有效。）

- **写入所有权分离**：后端写状态列、子进程写结果列，两组列不相交所以不需要锁。规则是"运行开始前存在的归后端，运行期间产生的归子进程"。
- **exit code 不足以说明失败原因**——后端只能观察到"子进程死了"，traceback 只有子进程看得见，原因必须由子进程写进库。
- **取消路径的破例**：子进程被杀后它拥有的列再也没人能写，后端接手关掉它（所有权分离防的是两个活着的写入者；写入者死后只剩一个）。
