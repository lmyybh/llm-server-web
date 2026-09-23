# Spec: 压测层级重构 —— Cell 取代 Run，Workload 全局化

Status: ready-for-agent

词汇表见 [`../../CONTEXT.md`](../../CONTEXT.md)，设计依据见 [`../../docs/design.md`](../../docs/design.md)，决策记录见 [`../../docs/adr/0001-cells-replace-runs.md`](../../docs/adr/0001-cells-replace-runs.md)。实现工单在 [`../bench-inspection-web/issues/`](../bench-inspection-web/issues/)（04–07、10–12）。

## Problem Statement

压测侧围绕 **Run**（一次档位扫描的执行记录，保留全部历史）组织，运行后发现三个结构性问题：

- **Workload 职责混杂**：负载形状（输入/输出 tokens 或数据集）与考核方式（模式 + 档位列表）混在一个实体里，两种变化理由互相牵扯
- **对比配对僵硬**：对比要求两次 Run 的档位阶梯完全相等——A 跑了 `[1,4,16]`、B 跑了 `[1,4,16,64]` 时，重叠的三个点明明可比却无法利用
- **历史成为负担**：保留全部执行历史带来配置漂移的仲裁成本，而 v1 实际没有趋势追踪需求；Deployment/Workload 可变的既定设计让历史 Run 的解释成本高企

## Solution

重构为 **Workload（全局库）+ Model → Deployment → Cell**：

- **Workload 收窄为纯负载形状**：全局共享的预置库，只有合成数据（input/output tokens）与真实数据集（名称）两种，恰好二选一；内容创建后不可变，被引用期间不可删除
- **Cell（压测组合）是最小执行单元**：挂在 Deployment × Workload 交叉点上的一次单点测量，参数只有 `mode`（concurrency|qps）、`level`（档位值）、`num_requests` 三项；唯一键 `(deployment_id, workload_id, mode, level)`
- **只存最新结果**：每个 Cell 保存最近一次执行的完整结果，重跑覆盖，没有执行历史；执行时冻结**执行快照**，配置改过未重跑时界面提示
- **对比自动配对**：跨 Deployment 按 `workload_id + (mode, level)` 对齐，只比交集；档位阶梯不必一致
- **固定值收敛**：warmup 固定 5 个请求、每次执行前恒 flush（无开关）、seed 内部固定不暴露

巡检侧完全不动。测量内核（SSE 解析、计时、直方图）不动。

## User Stories

### Workload 库

1. 作为工程师，我想有一个全局 Workload 库，以便常用负载形状只定义一次、各处复用
2. 作为工程师，我想创建合成 Workload 时说明输入/输出 token 数，以便精确控制负载形状
3. 作为工程师，我想创建数据集 Workload 时只选已登记的数据集名，以便不必关心 token 数
4. 作为工程师，我想让两种 Workload 恰好二选一，以便不会出现形状含糊的配置
5. 作为工程师，我想让 Workload 内容创建后不可变，以便"类别"不会漂移、引用它的对比永远有效
6. 作为工程师，我想让被引用的 Workload 不可删除，以便已有 Cell 不失锚
7. 作为工程师，我想在库里看到每个 Workload 的被引用数，以便知道删哪个是安全的

### Cell 配置

8. 作为工程师，我想在 Deployment 详情页从库中选 Workload 并配置 Cell，以便建立"这个部署要跑哪些压测组合"
9. 作为工程师，我想输入一组档位值后自动展开成多个 Cell，以便批量配置而不逐个点
10. 作为工程师，我想为每个 Cell 选择并发或 QPS 模式，以便分别回答"能扛多少"和"这个到达率下稳不稳"
11. 作为工程师，我想逐 Cell 调整 num_requests，以便高并发档位能要更多请求数
12. 作为工程师，我想让同 mode 同 level 的重复 Cell 被拒绝，以便一个组合永远只有一份最新结果
13. 作为工程师，我想让合成 Workload 的 token 数超过 Deployment 生成上限时在创建时被拒，以便不排出百万 token 的请求

### 执行

14. 作为工程师，我想单独重跑某一个 Cell，以便补一个点而不必整批重跑
15. 作为工程师，我想一键跑全部 Cell，以便完整扫描不必逐个触发
16. 作为工程师，我想在点开始之前看到预估耗时，以便知道要等多久
17. 作为工程师，我想让执行全局串行排队，以便我的数字不被别人的压测污染
18. 作为工程师，我想对运行中的 Cell 再点开始时被明确拒绝，以便不会无意中杀掉正在产生的数据
19. 作为工程师，我想取消一个运行中的 Cell 且已完成 Cell 的结果保留，以便取消不浪费数据
20. 作为工程师，我想每个 Cell 执行前自动 warmup 并 flush 缓存，以便数字面对冷前缀缓存且不可关闭

### 结果

21. 作为工程师，我想看到每个 Cell 的 TTFT/TPOT/E2E 分位数、吞吐、成功率与直方图，以便找到服务开始劣化的位置
22. 作为工程师，我想让曲线按 (Workload, mode) 分组、X 轴为档位，以便看清伸缩趋势
23. 作为工程师，我想每个曲线点标注执行时间，以便知道这条读时拼装的曲线是否混血
24. 作为工程师，我想改过 Cell 配置后看到"结果来自旧配置"的提示，以便不把旧数字当新配置的
25. 作为工程师，我想下载 Cell 的原始产物，以便口径修正后能重算指标
26. 作为工程师，我想界面上说明计时口径，以便不把服务时间误读成用户感知响应时间

### 对比

27. 作为工程师，我想勾选多个 Deployment 后直接看到对比，以便不必手工挑选执行记录
28. 作为工程师，我想对比自动按 Workload 与档位对齐、只比交集，以便阶梯不同时重叠点仍可利用
29. 作为工程师，我想缺失的点显示"未测"，以便知道差异来自没跑而不是跑不出来
30. 作为工程师，我想跨 Model 的对比无法进行，以便不被"差异来自模型本身"误导
31. 作为工程师，我想看到双方执行器/负载发生器版本差异的提示，以便知道尺子有没有换过

## Implementation Decisions

- **测量内核不动**：SSE 解析、逐请求计时、TPOT、直方图、调度模型全部保留（工单 01/02 的成果继续有效）；仅删除负载形状自动生成模块，warmup 收敛为固定 5
- **存储层重写**：`run` / `level_result` 表废弃；`workload` 表全局化（去掉 deployment_id 与考核字段，加 kind + 二选一列）；新增 `cell` 表——唯一键 `(deployment_id, workload_id, mode, level)`，结果列（分位数、吞吐、直方图、finish reasons、错误分类）与 `executed_snapshot_json`、`last_run_at`、`pid`、`artifact_dir` 直接挂在 cell 上。**数据库推倒重建，不写迁移**（ADR-0001）
- **执行器子进程改为单 Cell**：一次 spawn 执行一个 Cell 的 warmup(5) → flush → 计时测量，退出前覆盖写结果列、执行快照与产物；写入所有权分离沿用（后端写状态、子进程写结果）
- **队列粒度为 Cell**：全局串行队列沿用；运行中的 Cell 重复提交返回 409；取消沿用进程组 kill + SQL 条件写入消 TOCTOU；启动时 reconcile 僵死 running
- **执行快照**：执行时冻结 Workload 形状、mode、level、num_requests、固定值、执行器标识、负载发生器版本；配置（num_requests）改过未重跑时接口返回 `stale: true`，界面提示
- **可比性简化**：三档差异机制（blocking/advisory/flagged）退场，判定 = 同 `workload_id` + 同 `(mode, level)`；对比接口按交集对齐；数据集哈希不再参与判定（执行时记入产物供审计）
- **预估耗时**：Cell 数 ×（warmup + 测量时长 + flush）；测量时长由 num_requests 与该 Deployment 最近完成 Cell 的延迟估算
- **产物**：每 Cell 一个目录（plan.json / level.jsonl / manifest.json / executor.log），重跑覆盖；下载接口校验路径不越出 artifacts 根；产物不含密钥
- **API 契约**：见 `docs/design.md` §7（workloads CRUD、cells 批量创建/run/cancel、compare、estimate）；`/api/runs/*` 与 `/api/internal/*` 全部删除
- **前端**：新增 Workload 库页；Deployment 详情页改为"选 Workload → 配 Cell → Cell 表格 + 分组曲线"；对比页改为自动配对 + 交集 + 执行时间标注；Run 详情页删除；图表组件复用

## Testing Decisions

**只测外部行为，不测实现细节。** 沿用既定的两条 seam，不新增：

- **Seam 1（主）— 后端 HTTP API**：建 Model → 建 Deployment → 建 Workload → 配 Cell → 发起执行 → 轮询进度 → 取结果，整条链路经 API 测；唯一约束 409、引用中 Workload 删除 409、运行中重跑 409、跨 Model 对比拒绝、可比性交集对齐、快照 stale 提示，全部在这一层断言
- **Seam 2 — 纯函数**：SSE 解析、TPOT、直方图、百分位等内核测试原样保留

先例：现有 `backend/tests/` 的 API 测试模式（真实库 + 假子进程）继续沿用；编排时序（warmup → flush → 计时）沿用"进程内替换依赖、断言事件精确顺序"的写法；前端用 vitest + 有状态假后端（`frontend/tests/helpers.ts` 的模式）。

需重写的测试：Cell CRUD 与执行链路、对比交集、产物覆盖、队列/取消、预估。内核与巡检测试不动。对拍工具（`tools/parity.py`）不受影响。

## Out of Scope

- **巡检侧的一切改动**（Service / Inspection Run / 用例集原样保留）
- **压测执行历史与趋势追踪**（Cell 只存最新结果）
- **数据库迁移**（推倒重建）
- **Mock 目标服务**（对拍仍是唯一集成测试）
- **SLO 判定、PASS/FAIL、阈值字段**
- **数据集内容哈希参与可比性判定**
- **负载形状的自动生成目录**（改为手工预置）

## Further Notes

- 决策全程记录于 ADR-0001，含 Run（保留历史）与 Benchmark（整曲线扫描）两个被否决方案的理由
- 实现工单（在 `../bench-inspection-web/issues/`）：04（Cell 数据模型与执行链路）→ 05（Workload 库与批量配置）、07（进度取消）、12（产物）→ 06（图表）→ 10（快照与可比性）→ 11（对比视图）
- 工单 01/02/03/08/09/13/14/15 已完成且不受本次重构影响
