# Spec: LLM 推理服务压测与巡检网站

Status: ready-for-agent

词汇表见 [`../../CONTEXT.md`](../../CONTEXT.md)，设计依据见 [`../../docs/design.md`](../../docs/design.md)。

## Problem Statement

我需要评估自建 LLM 推理服务的性能与接口健康度，但现在做这件事的体验很糟：

- 跑一次压测要记一堆命令行参数，或者去改 shell 脚本里的硬编码值
- 结果散落在各个机器上的 JSONL 文件里，没有地方能看到"我到底跑过哪些"、''这一次比上一次好还是差"
- 改了部署方式（换拓扑、调参数）之后想知道有没有变好，只能凭记忆回忆改了什么，再把两份文件摆在一起肉眼比对
- 服务出问题时，除了压测没有别的手段，只能一个个接口手动 curl，看不出"健康检查通过但实际 generate 已经卡死"这类问题
- 现成的工具要么只写文件不写库、要么只能单次触发，没有历史、没有对比、没有可视化

我需要的是一个网站：把"评价一台推理服务"变成可复现、可归档、可对比的操作。

## Solution

一个网站：压测侧是全局共享的 **Workload 库** + **Model → Deployment → Cell** 三层组织，另有一个**完全独立**的巡检入口。

- Workload 是预置的负载形状库（合成 tokens 或真实数据集名），全站共享、内容不可变
- 在 Model 下建立多种 Deployment（同一模型的不同部署方式），填一次 router 地址与默认参数即可反复使用
- 在 Deployment 上从库中选 Workload、配置 Cell（模式 + 档位值 + 请求数），界面先告知预计耗时
- Cell 是最小执行单元：单点执行、逐点出结果、支持取消；每个 Cell 只保留最新结果，重跑覆盖
- 结果以曲线、直方图、逐点表格呈现；每次执行冻结一份执行快照
- 同一 Model 下的多个 Deployment 自动按 Workload 与档位对齐并排对比
- 巡检是独立入口：登记一个服务 URL，点一下，得到一份用例红绿灯

网站的测量能力**自己实现**，不依赖任何外部压测程序。

## User Stories

### Model 与 Deployment 管理

1. 作为推理服务工程师，我想把一个模型登记为一个 Model，以便它的所有部署变体集中在一处
2. 作为工程师，我想在同一个 Model 下建立多个 Deployment，以便比较同一模型的不同部署方式
3. 作为工程师，我想在 Deployment 上填一次 router 地址和模型名，以便不必每次压测都重填
4. 作为工程师，我想登记部署元数据（GPU 型号、数量、拓扑、镜像），以便报告自带上下文
5. 作为工程师，我想新建 Deployment 时自动复制上一个 Deployment 的配置（除名称），以便变体之间只差我要改的那几项
6. 作为工程师，我想让已存在的 Deployment 保持创建时的值不变，以便已产出的 Cell 结果始终可解释
7. 作为工程师，我想在 Deployment 上编辑参数而不必新建一个 Deployment，以便调参不产生实体膨胀

### 发起压测

8. 作为工程师，我想从预置的 Workload 库中选择负载形状，以便常用形状只定义一次、各处复用
9. 作为工程师，我想单独重跑某一个 Cell 或修改它的请求数，以便探测边界而不必整批重跑
10. 作为工程师，我想按 Workload 分组管理 Cell，以便专注关心某一种形状
11. 作为工程师，我想为每个 Cell 选择并发模式或 QPS 模式，以便分别回答"能扛多少"和"这个到达率下稳不稳"
12. 作为工程师，我想给同一个 Workload 配置不同模式、不同档位的多个 Cell，以便同时覆盖并发扫描与 QPS 扫描
13. 作为工程师，我想在点开始之前看到预计耗时，以便知道要等多久
14. 作为工程师，我想在点了开始之后进入队列而不是立刻并发执行，以便我的数字不被别人的压测污染

### 运行中

15. 作为工程师，我想看到当前正在跑哪个 Cell（哪个 Workload、哪个模式、哪个档位值），以便知道它没卡死
16. 作为工程师，我想取消一个运行中的 Cell，以便参数填错时不必等它跑完
17. 作为工程师，我想在取消之后保留已完成 Cell 的结果，以便取消不浪费已经得到的数据

### 结果查看

18. 作为工程师，我想看到每一档的 TTFT、TPOT、E2E、吞吐、成功率，以便找到服务开始劣化的位置
19. 作为工程师，我想看到每一档的延迟分布直方图，以便发现 p99 掩盖的双峰分布
20. 作为工程师，我想看到同一 Workload 下一组 Cell 拼出的整体分布，以便把握整体情况
21. 作为工程师，我想看到每一档的 finish reason 与错误分类，以便区分"输出被截断"和"请求失败"
22. 作为工程师，我想在界面上看到计时口径的说明，以便不把服务时间误读成用户感知的响应时间
23. 作为工程师，我想下载一个 Cell 的原始产物，以便将来口径被修正时能重算指标
24. 作为工程师，我想看到每个 Cell 上次执行时冻结的执行快照，并在配置改过未重跑时被提示

### 对比

25. 作为工程师，我想在同一 Model 下勾选多个 Deployment 并排对比，以便选出更好的部署方式
26. 作为工程师，我想在对比视图里看到双方 Cell 执行快照的差异提示（如负载发生器版本不同），以便知道数字背后有没有条件变化
27. 作为工程师，我想让对比自动按 Workload 与档位对齐、只比交集，以便不必手工配对且永远不会比到不可比的点
28. 作为工程师，我想让跨 Model 的对比无法进行，以便不被"差异来自模型本身"所误导
29. 作为工程师，我想在 Deployment 详情里一眼看到各 Cell 的最近执行时间与状态，以便快速扫视

### 数据集

30. 作为工程师，我想在后端的配置文件里登记业务数据集路径，以便它们对压测可用
31. 作为工程师，我想让真实数据集预置且视为不变，以便同一数据集名永远指向同一份数据
32. 作为工程师，我想让 synthetic Workload 与业务数据集分别打到不同的端点，以便两者都能测

### 巡检

33. 作为工程师，我想有一个独立的巡检入口，以便接口健康检查与性能评估不纠缠在一起
34. 作为工程师，我想只填一个服务 URL 就能登记一台待巡检服务，以便准备工作最少
35. 作为工程师，我想让巡检除了 chat 接口外还检查 `/health`、`/health_generate`、`/get_model_info`，以便发现"健康检查通过但实际无法生成"的服务
36. 作为工程师，我想让巡检发出真实的生成请求而不只探健康端点，以便证明 prefill 与 decode 真的发生了
37. 作为工程师，我想看到逐条用例的通过/失败，以便一眼看出哪里坏了
38. 作为工程师，我想区分 `INCONCLUSIVE` 与 `FAIL`，以便"测不出来"不被误读成"服务坏了"
39. 作为工程师，我想看到一台服务的巡检历史，以便判断某个问题是不是新出现的
40. 作为工程师，我想让巡检与压测在数据和配置上完全独立，以便两边各自演进、互不牵连

### 凭据与安全

41. 作为工程师，我想让网站只记录 API key 所在的**环境变量名**而不存储密钥本身，以便工具不可能泄漏凭据
42. 作为工程师，我想让网站只通过 router URL 寻址被测服务，以便不必枚举 prefill/decode worker

### 可信度

43. 作为工程师，我想让自研的负载发生器与既有工具对拍验证过，以便我敢把结论建立在这些数字上

## Implementation Decisions

### 模块划分

| 模块 | 职责 | 关键接缝 |
|---|---|---|
| **负载发生器** | 发请求、计时、采集逐请求观测 | 其对外边界是「一个 HTTP 目标」，可注入 |
| **SSE 解析器** | 字节流 → 事件流，增量、跨分片安全 | 纯函数：字节进、事件出 |
| **测量与统计** | TPOT 计算、直方图分桶、百分位 | 纯函数 |
| **编排** | 遍历测量项与档位、执行 warmup → flush → 计时 时序 | 依赖负载发生器与目标客户端 |
| **巡检引擎** | 目标发现、用例执行、断言、恢复验证 | 依赖 HTTP 客户端；断言谓词是纯函数 |
| **后端 API 与数据层** | 对外 HTTP、队列、状态所有权、页面数据聚合 | HTTP API 即最高接缝 |
| **子进程管理** | spawn、进度接收、取消 | 与后端之间的写入所有权契约 |
| **前端** | 页面与图表 | 只消费后端 HTTP API |

### 进程与写入所有权

压测与巡检各以**一次性子进程**执行：后端 `spawn`，子进程跑完退出，取消即 `kill` 进程组。

**子进程直接写数据库。** 为避免两个进程写库冲突，采用**写入所有权分离**：

- 后端只写 Cell 的**状态**字段（`status`、`queued_at`、`started_at`、`finished_at`、`error`）
- 子进程只写 Cell 的**结果与进度**字段（`progress`、各指标列、执行快照、产物路径）

两者不写同一列，因此不需要任何锁。SQLite 开 **WAL 模式**以支持并发写。

### 单个 Cell 的执行时序（原型级精确）

每个 Cell 都独立执行这个序列，**不是每进程一次**：

```
warmup（固定 5 个请求）
  → POST {router_url}/flush_cache
  → 计时测量
  → 写 cell 结果
```

- flush **只打入口 router**，不逐节点。PD 分离架构也只登记一个 router URL
- flush **不提供关闭开关**——一旦可选就多出一根不可比轴
- warmup 每次测量前都要做，用于让运行时进入稳态（CUDA graph capture、内存池分配）

### 测量口径（必须固定）

- **计时起点**：HTTP 请求真正发出的那一刻。**排队等待并发许可的时间不计入**
- **TTFT**：起点 → 第一个非空文本增量（`content` 或 `reasoning_content`），**不是第一个 chunk**
- **E2E**：起点 → 响应流结束
- **TPOT**：`(E2E − TTFT) / (completion_tokens − 1)`；当 `completion_tokens ≤ 1` 或 `E2E < TTFT` 时**无值**而非 0
- **百分位**：numpy 线性插值，全站统一

沿用既有口径是刻意的：这样能与工作区里已跑出的历史 JSONL 保持可比。

**已知口径后果**：高并发档位下呈现的是**服务时间**而非用户感知的响应时间，界面必须说明。

### 端点选择

| workload 来源 | 端点 |
|---|---|
| synthetic（prefill/decode 阶梯、balanced、long-long、context-boundary） | `POST /v1/completions` |
| 业务数据集 | `POST /v1/chat/completions` |

### 存储粒度

**每个 Cell 存一份指标分布（固定分桶的直方图 + 分位数），不存逐请求明细进库。**

同组 Cell 的整体分布 = **各 Cell 直方图相加**（直方图可加，前提是同一指标使用同一套分桶边界）。

**已知取舍**：无法回溯"这个点里最慢的那个请求长什么样"。原始逐请求数据以 JSONL 落在产物目录里，数据库不存。

### 数据模型

```
model(id, name, note, created_at)

deployment(id, model_id, name, note, router_url, model_name, api_key_env,
           context_length, gpu_model, gpu_count, topology, image,
           created_at, updated_at)

workload(id, name, note, kind,             -- kind: synthetic | dataset
         input_tokens, output_tokens,     -- 仅 synthetic
         dataset, created_at)             -- 仅 dataset

cell(id, deployment_id, workload_id, mode, level, num_requests,
     status, progress_json, executed_snapshot_json, last_run_at,
     total_requests, successful_requests, failed_requests, duration_seconds,
     achieved_qps, input_token_throughput, output_token_throughput,
     ttft_histogram_json, tpot_histogram_json, e2e_histogram_json,
     ttft_p50, ttft_p95, ttft_p99, tpot_p50, tpot_p95, tpot_p99,
     e2e_p50, e2e_p95, e2e_p99,
     finish_reasons_json, error_categories_json,
     artifact_dir, pid, queued_at, started_at, finished_at, error,
     UNIQUE (deployment_id, workload_id, mode, level))

# 巡检侧，完全独立
service(id, name, note, router_url, api_key_env, created_at, updated_at)
inspection_run(id, service_id, suite_version, status, verdict,
               current_case, progress, started_at, finished_at, error, artifact_dir)
inspection_case_result(id, inspection_run_id, case_id, required,
                       verdict, reason_code, message, evidence_count, details_json)
```

### Cell 的状态

`idle` / `queued` / `running` / `completed` / `failed` / `cancelled`。

**不做任何 SLO 判定**，不产出 PASS/FAIL，不计算"最高通过档位"。拐点由人看曲线判断。

**Deployment 上不设任何阈值字段**（TTFT p99 / TPOT p99 / 最低成功率一概不要）。图表上也不画参考线——没有阈值的世界更简单，而拐点本来就该由人对着曲线判断。

### Cell 的配置

Cell 是 (Deployment, Workload) 交叉点上的一次单点测量，可调参数只有三个：

- `mode`：`concurrency`（闭环）或 `qps`（开环）
- `level`：档位值（并发数或 offered QPS）
- `num_requests`：请求数；可修改，**不属于唯一键**

唯一键：`(deployment_id, workload_id, mode, level)`。固定值：warmup=5、每次执行前恒 flush（无开关）、seed 内部固定。Cell 只保存最新一次结果，重跑覆盖，**没有执行历史**。

### 执行快照

Cell 每次执行时冻结：Workload 形状（含数据集名）、mode、level、num_requests、固定值（warmup、flush、seed）、执行器标识、负载发生器版本。

它是"结果是否来自当前配置"的判定依据：配置改过未重跑时，界面必须提示。

### 可比性

**严格限制在同一 Model 之下的不同 Deployment 之间。** 跨 Model 不对比。

可比的充要条件：**引用同一个 Workload（按身份，即 workload_id）且 mode 与 level 相同**。档位阶梯不必一致——对比时取双方的**交集**逐点对齐；没有共同点则不比。不做数据集内容哈希校验（真实数据集预置且视为不变）。

### API 契约

```
GET    /api/models
POST   /api/models
GET    /api/models/{id}

GET    /api/models/{id}/deployments
POST   /api/models/{id}/deployments
GET    /api/deployments/{id}
PATCH  /api/deployments/{id}

GET    /api/workloads                      # Workload 全局库
POST   /api/workloads
PATCH  /api/workloads/{id}                 # 仅名称与备注
DELETE /api/workloads/{id}                 # 被 Cell 引用时 409

GET    /api/deployments/{id}/cells
POST   /api/deployments/{id}/cells         # body: workload_id, mode, levels[], num_requests
PATCH  /api/cells/{id}                     # 仅 num_requests
DELETE /api/cells/{id}
POST   /api/cells/{id}/run                 # 运行中 → 409
POST   /api/cells/{id}/cancel
GET    /api/cells/{id}                     # 状态 + 最新结果 + 执行快照
GET    /api/cells/{id}/artifacts           # 原始产物下载

GET    /api/compare?model_id=&deployment_ids=   # 自动按 workload_id + (mode, level) 对齐

# 巡检（独立）
GET    /api/services
POST   /api/services
GET    /api/services/{id}
GET    /api/services/{id}/inspections
POST   /api/services/{id}/inspections
GET    /api/inspections/{id}
GET    /api/inspections/{id}/cases

```

结果与进度由子进程直接写库（写入所有权分离），前端轮询读取。

### 巡检的执行与判定

1. 目标发现：`/health` → `/v1/models` → `/model_info` → `/v1/tokenize`；发现失败则 Inspection Run 置为 `failed`
2. 按固定顺序跑用例集，逐条断言、逐条写库
3. 汇总规则：
   - 任一**必需**用例 `FAIL` 或 `ERROR` → Inspection Run `FAIL`
   - 否则任一必需用例 `INCONCLUSIVE` → Inspection Run `INCONCLUSIVE`
   - 否则 Inspection Run `PASS`

**`INCONCLUSIVE` 与 `FAIL` 绝不可合并。** 前者表示"测不出来"，后者表示"服务违反了契约"。

用例集带**版本号**并记入 Inspection Run——用例集版本不同，两次巡检的结果不可比。

### 凭据处理

网站**不接收、不存储** API key，只记录 API key 所在的**环境变量名**。执行时由子进程的环境提供。密钥永不落盘、永不入库、永不写入产物。

### 数据集配置

数据集是后端同机上的文件，在配置文件中登记（不通过网页上传）：

```json
{
  "datasets": [
    {"name": "claw", "path": "/data/datasets/claw.jsonl"},
    {"name": "muses-v4-flash", "path": "/data/datasets/muses-v4-flash.jsonl"}
  ]
}
```

JSONL 格式，每行一个 payload 对象（含 `messages` 或 `prompt`）。**数据集视为预置且不变，不做内容哈希校验**；执行时计算 sha256 记入产物供审计，但不参与可比性判定。

### 部署与访问控制

内网部署，一层简单口令（开发期监听 `localhost`）。不做账号体系。

### 前提约束

- 被测服务必须接受 SGLang 风格的流式扩展字段（`stream_options.continuous_usage_stats`、`return_cached_tokens_details`、`ignore_eos`）
- 被测服务必须暴露 `POST {router_url}/flush_cache`
- 被测服务必须暴露 `/v1/models` 且能唯一确定 context length

## Testing Decisions

### 什么算好的测试

**只测外部行为，不测实现细节。** 一次测量得到一个数字——测试断言的是"数字是否符合定义"，而不是"内部调用了什么"。

这个项目里有一类特别重要的测试：**口径测试**。自研负载发生器最危险的不是跑不起来，而是**跑起来了、数字看起来合理、但系统性偏移**（TTFT 起点差一次事件循环、TPOT 少减一个 1、百分位用错插值）。这类错误不报错，只会在几个月后以"数据好像不太对"的形式发作。因此口径必须有直接的测试断言。

### Seams

**Seam 1（主）— 后端 HTTP API。** 编排、持久化、子进程生命周期、进度上报，全部通过它测。最高的一层：一次测试覆盖"建 Model → 建 Deployment → 建 Workload → 配 Cell → 发起执行 → 轮询进度 → 取结果"整条链路。

**Seam 2 — SSE 增量解析器（纯函数）。** 全项目最容易写错、且错了不报错的地方之一。它最关键的用例（事件被切在 UTF-8 多字节中间、多个事件挤在一个 chunk）通过真实 socket 复现既麻烦又不稳定，因此单开纯函数接缝。

**不建 mock 目标服务。** 负载发生器与巡检引擎的真实行为在**真实目标**上验证（见下方「对拍」）。理由：一个错误的 mock 会给出**虚假的安心**——它按你理解的协议回包，而你写的解析器也按同一理解写，两边一起错、测试全绿。真实目标不会附和你的误解。

**代价必须承认**：本机没有推理服务，因此负载发生器与编排的**离线**测试能力大幅收窄，开发迭代依赖能连上真实目标。离线唯一能覆盖的是纯函数（SSE 解析、TPOT、直方图、百分位）与断言语义。

### 需要被测的模块

| 模块 | 测试层级 | 重点 |
|---|---|---|
| SSE 解析器 | Seam 2，纯函数 | 分片边界、UTF-8 多字节、多行 `data:`、`[DONE]` |
| 测量与统计 | 纯函数 | TPOT 公式（含 `completion_tokens ≤ 1` 无值）、百分位、直方图可加性 |
| 巡检断言谓词 | 纯函数，喂**构造的观测记录**（不经过 HTTP） | 4 个谓词的精确规则；`INCONCLUSIVE` 与 `FAIL` 的区分 |
| 编排时序 | 进程内替换 HTTP 客户端与 flush 调用，断言**事件的精确顺序** —— 这不是 mock 服务程序，只是测试时把依赖换成假的，先例见下 | **warmup → flush → 计时 的顺序**；每个 Cell 都独立执行一次；取消后已完成 Cell 保留 |
| 负载发生器 | **真实目标**（对拍） | 闭环并发上限、开环到达率、逐请求计时 |
| 后端 API | Seam 1 | 队列串行性、状态机、进度、取消、配置快照冻结 |
| 可比性判定 | Seam 1 | 跨 Model 被拒；无共同 (workload, mode, level) 时不比 |

### 先例（prior art）

- **`ai-infra-bench` 的 `tests/performance/test_bench.py`** 是最好的一份先例：它用 monkeypatch 把 `run_requests` / `flush_cache` / session 换掉，然后**断言事件的精确顺序**（`[("run", requests[:1]), ("flush", None), ("run", requests)]`），测试名直接叫 `test_regular_warmup_flushes_before_formal_run`。本项目的 warmup/flush 时序测试应当照这个模式写。
- `ai-infra-bench` 还有一个 `test_disable_flush_cache_skips_preparation_across_concurrency_sweeps`，展示了如何断言"跨档位共享状态"这类容易错的行为。
- **`llm_tools` 的 `tests/`** 展示了断言谓词的测试写法，包括一个专门针对 SGLang 错误响应形状的测试（`test_sglang_error_shape_and_tool_fixture_do_not_create_false_failures`）——防止把合法的 SGLang 错误形状误判为失败。
- **`chat-web`** 用 vitest 测前端；若前端有逻辑（如对比视图的档位对齐），照它的模式。

### 对拍（硬性验收，不是可选）

**同一个 target、同一份配置，本站负载发生器与 `aib` 各跑一次**，以下指标必须在统计噪声内一致：TTFT 的 p50/p99、E2E 的 p50/p99、TPOT 的 p50/p99、输出吞吐、成功率。

**因为不建 mock 服务，对拍还额外承担了集成测试的角色**：它是验证负载发生器、编排时序、flush 契约、SSE 解析在真实协议下都正确的**唯一**手段。离线能覆盖的只有纯函数。

**这也让对拍的优先级更高**：M1 之前不应开始写前端。

## Out of Scope

- **持续巡检与告警** —— 需要调度器 + 通知通道 + 误报治理，是独立的一块工程
- **多人协作 / 账号体系**
- **资源侧指标采集**（GPU / Prometheus / 被测服务 `/metrics`）—— v1 纯端到端
- **跨服务的批量巡检**
- **巡检结果的对比**
- **跨 Model 的任何对比或并排视图**
- **启动 / 停止 / 扩缩容被测服务** —— 被测服务的生命周期不在本站管理范围内
- **逐请求明细的存储与"最慢请求"回溯**
- **压测执行历史** —— Cell 只保存最新一次结果，重跑覆盖（ADR-0001）
- **请求粒度的实时曲线**
- **网页上传数据集**
- **自动容量搜索 / 饱和边界判定** —— 档位由人指定
- **SLO 判定、PASS/FAIL 结论、阈值字段与图表参考线**
- **依赖 `aib` 或 `llm_tools`** —— 运行时不需要它们存在
- **Mock 目标服务** —— 负载发生器与巡检引擎的真实行为在真实目标上验证

## Further Notes

### 里程碑与关口

| 阶段 | 内容 |
|---|---|
| **M0** | 自研负载发生器 + 纯函数测试 |
| **M1** | **对拍通过** ← 关口 |
| **M2** | Model / Deployment 管理 |
| **M3** | Cell 数据模型 + 单点执行链路 |
| **M4** | Workload 全局库 + Cell 批量配置 + 队列/预估/取消 |
| **M5** | Cell 图表 + 执行快照 + 对比视图 + 产物 |
| **M6** | 巡检 |

**M1 通过之前不要开始写前端。** 否则会在一套未经验证的数字体系上搭界面。

### 已知风险（按重要性）

1. **自研负载发生器的口径偏移** —— 本项目最大的技术风险，由对拍缓解
2. 高并发下显示的是服务时间而非用户感知响应时间 —— 已知口径，界面说明
3. 无逐请求明细，无法回溯最慢请求 —— 已接受
4. 后端与子进程都可写库 —— 由写入所有权分离约束
5. 压测与巡检需两处各配一次 URL —— 已接受
6. 全局串行队列意味着长任务会阻塞其他人 —— 由预估耗时显示缓解
7. 历史数据的口径来自 `aib` —— 沿用其计时与百分位口径以保持可比
