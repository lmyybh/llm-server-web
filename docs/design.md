# LLM 推理服务压测与巡检网站 — 设计文档

词汇表见 [`../CONTEXT.md`](../CONTEXT.md)。本文档记录**已确定的决策**与由它们推导出的设计。

压测侧层级于 2026-09-18 重构（Run/Benchmark 两版方案均被否决），决策与取舍见 [`adr/0001-cells-replace-runs.md`](./adr/0001-cells-replace-runs.md)。

---

## 1. 目标与范围

### 1.1 v1 的目的

借助网站做好三件事：**可视化**、**容易操作**、**数据管理**。

### 1.2 v1 的功能范围

只含两块：**压测**与**巡检**。

### 1.3 明确不做（已决策，不要再提）

| 不做 | 原因 |
|---|---|
| 持续巡检与告警 | 需要调度器 + 通知通道 + 误报治理，是独立的一块工程 |
| 多人协作 / 账号体系 | 使用者是同组内部，v1 不做 |
| 资源侧指标（GPU / Prometheus / `/metrics` 采集） | v1 纯端到端 |
| 跨服务的批量巡检 | 巡检各管各 |
| 巡检结果的对比 | 巡检交付的是"通过/失败"，不是可比的数值 |
| 跨 Model 的任何对比 | 差异来自模型本身而非部署方式 |
| 启动/停止/扩缩容被测服务 | 被测服务的生命周期不在本站管理范围内 |
| **压测执行历史** | Cell 只存最新结果，重跑覆盖；趋势追踪是另一块工程（见 ADR-0001） |

### 1.4 使用者与部署

同组内部小工具。部署在内网机器上，一层简单口令即可（开发期监听 `localhost`）。

**凭据纪律**：网站**不接收、不存储** API key，只记录 API key 所在的**环境变量名**。执行时由压测/巡检进程的环境提供。

---

## 2. 系统架构

### 2.1 技术栈

| 层 | 选型 | 理由 |
|---|---|---|
| 后端 | **Python + FastAPI** | 与测量代码、数据处理、将来的时序分析同生态 |
| 前端 | **Next.js 14 + React 18 + TypeScript + Tailwind** | 复用工作区里已验证的 `chat-web` 栈 |
| 存储 | **SQLite（WAL 模式）+ 原始产物落盘** | 单机、单写入者为主；WAL 支持子进程并发写 |
| 负载发生器 | **自研**（参考 `aib` 源码实现） | 见 §2.4 |

### 2.2 不依赖外部工具

本站**不依赖 `aib`，也不依赖 `llm_tools`**，运行时不需要它们存在。

- `llm_tools` 的**编排逻辑**与**巡检用例集**作为设计参考被**移植**成本站自己的代码。
- `aib` 的**负载实现**（并发模型、到达率调度、SSE 解析、计时、token 统计）作为实现参考被**重写**。

**因为自研，以下 `aib` 的怪癖自动消失，不再需要考虑**：`--num-warmup-requests 0` 会连带禁用 flush；退出码永远为 0；`--metrics-path` 的拼写陷阱；warmup+flush 每进程只做一次。

### 2.3 进程模型

```
┌─────────────────────┐
│  Next.js 前端        │
└──────────┬──────────┘
           │ HTTP
┌──────────▼──────────┐
│  FastAPI 后端        │  ← 唯一对外提供 API 的进程
│  · 任务编排与队列     │
│  · Cell 状态所有权    │
│  · 页面数据聚合       │
└──────────┬──────────┘
           │ spawn（同机）
┌──────────▼──────────┐
│  压测子进程 / 巡检子进程 │  ← 一次性：启动 → 跑完 → 退出
│  · 自研负载发生器      │
│  · Cell 结果所有权     │
└─────────────────────┘
           │ HTTP
      ┌────▼────┐
      │ 被测服务  │  （只寻址 router URL）
      └─────────┘
```

**为什么是一次性进程而不是常驻 executor**：隔离（压测吃内存与连接数，跑完完全归还）、取消（`kill` 进程组）、崩溃（只影响这一次）。调度器按 router URL 限制并发：相同 URL 的 Cell 串行，不同 URL 的 Cell 可并行。将来要做分布式时，只需把"本机 spawn"换成"请求远程 agent spawn"，其余契约不变。

**子进程直接写数据库。** 为避免两个进程写库的冲突，采用**写入所有权分离**：

- **后端**只写 Cell 的**状态**字段（`status`、`queued_at`、`started_at`、`finished_at`、`error`）
- **子进程**只写 Cell 的**结果与进度**字段（`progress`、各指标列、执行快照、产物路径）

规则是：**运行开始前存在的东西归后端，运行期间产生的东西归子进程。** 两者不写同一列，因此不需要任何锁。SQLite 开 WAL 模式以支持并发写。

### 2.4 自研负载发生器需要实现什么

这是本项目工作量最大的一块，也是**最容易"跑起来了但数字系统性偏移"**的一块。已实现（见工单 01/02）：高并发异步 HTTP 客户端、闭环/开环两种调度、跨 chunk 边界的增量 SSE 解析、逐请求计时（TTFT/E2E）、TPOT、流式 usage 聚合、warmup 与 flush 时序、失败分类、直方图与分位数。

**验证手段见 §8（对拍方案）——已通过，是自研路线的安全网。**

---

## 3. 领域模型

### 3.1 两个互不相关的体系

```
压测体系                          巡检体系
────────                          ────────
Workload（全局库，独立管理）         Service
Model                             └── Inspection Run
└── Deployment
    ├── 添加的 Workload（不配参数）
    └── Cell（挂在 Deployment × Workload 交叉点）
```

**两边完全独立，不共享任何实体、不互相引用。** 同一个服务若要既压测又巡检，需要在两处**各配一次**。这是刻意的：压测与巡检是两种不同的节奏下做的两件事，强行关联会引入一个两边都要维护的中间实体。

### 3.2 Workload：全局负载形状库

Workload 是**预置的负载形状**，独立管理，不属于任何 Model 或 Deployment：

- **合成数据**：说明输入/输出 token 数
- **真实数据集**：只给数据集名（不说 token 数）

恰好二选一。Workload 不含任何压测参数——模式、档位、请求数都不在这一层。

**添加不等于配置**：Workload 先被添加到 Deployment 名下（可以先添加、后配 Cell），压测参数属于 Cell。创建首个 Cell 时若尚未添加会自动添加。

**内容创建后不可变**（名称与备注除外）：Workload 是"类别"，类别内容漂移会让所有引用它的配对失效。要改形状就新建一个。**被添加或被 Cell 引用期间不可删除。**

### 3.3 Cell：压测组合

Cell 挂在 **Deployment × Workload** 的交叉点上，是一次**单点测量**：

| 字段 | 说明 |
|---|---|
| `mode` | `concurrency`（闭环）或 `qps`（开环） |
| `level` | 档位值：并发数或 offered QPS |
| `num_requests` | 请求数；可修改，**不属于唯一键** |

**唯一键**：`(deployment_id, workload_id, mode, level)`——同一 Deployment 下、同一 Workload、同模式同档位的 Cell 不允许重复。

**固定值**（不是可调参数，写死在执行路径上）：预热请求数 = **5**；每次执行前 **flush**（恒开，无开关）；随机种子内部固定。

**结果语义**：Cell 只保存**最新一次**结果，重跑整体覆盖，**没有执行历史**。 Cell 是**最小执行单元**——可单独重跑，"跑全部"只是把一个 (Deployment, Workload) 下的 Cell 批量入队。

### 3.4 执行快照

Cell 每次执行时冻结一份配置副本存在 Cell 上：当时的 Workload 形状、`mode`、`level`、`num_requests`、固定值（预热、flush、种子）、执行器标识、负载发生器版本。

它承担原 Run Signature 的职责：页面展示结果以快照为准；**Cell 配置修改后未重跑，快照与当前配置不一致，界面必须提示**（"配置已修改，结果来自旧配置"）。

### 3.5 Comparability（可比性）

**严格限制在同一 Model 之下的不同 Deployment 之间。** 跨 Model 不对比。

可比的充要条件：**引用同一个 Workload（按身份，即 workload_id）且 `mode` 与 `level` 相同**。

**档位阶梯不必一致。** 不同 Deployment 各跑各的阶梯，对比时取两者的**交集**逐点对齐；某方缺某个点显示"未测"；没有共同点则不比。不做数据集内容校验——真实数据集预置且视为不变。

**已知取舍**：曲线是读时由 Cell 拼装而成，各点可能执行于不同时间、不同条件，页面上无法直接看出。接受此代价，换取任意重叠子集可比与单点重跑（见 ADR-0001）。界面应展示每个点的执行时间作为缓解。

---

## 4. 数据模型

### 4.1 概览

```
model(id, name, note, created_at, updated_at)

deployment(id, model_id, name, note,
           router_url, model_name, api_key_env,
           context_length,              -- 可空，空则运行时发现
           synthetic_input_limit,       -- 合成 Workload 的输入 token 校验上限
           gpu_model, gpu_count, topology, image,   -- 展示用元数据
           created_at, updated_at)

workload(id, name, note,
         kind,                        -- synthetic | dataset
         input_tokens, output_tokens, -- kind=synthetic 时必填，否则为空
         dataset,                     -- kind=dataset 时必填，否则为空
         created_at)

cell(id, deployment_id, workload_id,
     mode,                            -- concurrency | qps
     level,                           -- 并发数 或 offered QPS
     num_requests,
     status,                          -- idle | queued | running | completed | failed | cancelled
     progress_json,                   -- 子进程写
     executed_snapshot_json,          -- 执行快照，子进程执行时冻结
     last_run_at,
     -- 结果列（子进程写，重跑整体覆盖）：
     total_requests, successful_requests, failed_requests,
     duration_seconds, achieved_qps,
     input_token_throughput, output_token_throughput,
     ttft_p50, ttft_p95, ttft_p99,
     tpot_p50, tpot_p95, tpot_p99,
     e2e_p50, e2e_p95, e2e_p99,
     ttft_histogram_json, tpot_histogram_json, e2e_histogram_json,
     finish_reasons_json, error_categories_json,
     artifact_dir, pid,
     queued_at, started_at, finished_at, error,
     UNIQUE (deployment_id, workload_id, mode, level))

-- 巡检侧（完全独立，不随本次重构变化）
service(id, name, note, router_url, api_key_env, created_at, updated_at)
inspection_run(id, service_id, status, verdict, ...)
inspection_case_result(id, inspection_run_id, case_id, ...)
```

**数据库推倒重建，不写迁移。** 原 `run` / `measurement` / `level_result` 表废弃（内部工具，既有数据无保留价值——见 ADR-0001）。

### 4.2 存储粒度的决策

**每个 Cell 存一份指标分布（固定分桶的直方图 + 分位数），不存逐请求明细进库。**

**已知取舍**：无法回溯"这个点里最慢的那个请求长什么样"。原始逐请求数据以 JSONL 落在产物目录里（§4.3），数据库不存。

### 4.3 原始产物

每 Cell 一个目录，`cell.artifact_dir` 指向它；**重跑时旧产物随结果一起被覆盖**：

```
artifacts/cells/<cell_id>/
├── plan.json       # 执行前冻结的配置（执行快照的落盘形式）
├── level.jsonl     # 逐请求的计时与 token 数（口径修正后重算的依据）
├── manifest.json   # 跑完（或失败）后的结果摘要
└── executor.log    # 子进程输出
```

**保留原始产物是刻意的**：负载发生器将来若修正口径，可依据 JSONL 重算。这是自研路线唯一的"后悔药"。产物中**不含任何密钥**（只存环境变量名）。

---

## 5. 执行流程

### 5.1 发起压测

1. 用户在 Deployment 详情页**添加 Workload**（从全局库选择，或当场新建一个入库），然后在卡片上点【新建 Cell】**配置压测**：单选模式（并发 / QPS）、填一组档位（并发档为整数，QPS 档可为小数）、填请求数量——**单值广播到所有档位，多值则与档位一一对应（数量必须一致）**。已存在的档位标注后自动跳过；非法输入内联报错并阻止提交。批量创建是一个事务：任一档位冲突则整批拒绝
2. 对单个 Cell 点【重跑】，或对一组 Cell 点【跑全部】；界面**先显示预估耗时**（按 §5.3 计算）
3. 后端入队（**按 router URL 串行**：同一 URL 的 Cell 按入队顺序执行，不同 URL 可并行）；**对正在运行的 Cell 再次点开始 → 409 拒绝**
4. 队列轮到时，后端置 Cell 为 `running` 并 `spawn` 压测子进程
5. 子进程执行单个 Cell，写结果、执行快照与产物后退出；后端把 Cell 置为 `completed` / `failed` / `cancelled`

### 5.2 单个 Cell 的执行时序

```
warmup（固定 5 个请求） → POST {router_url}/flush_cache → 计时测量 → 写结果
```

- **warmup 每次执行前都要做**（让运行时进入稳态），不是每进程一次
- **flush 在 warmup 之后**，保证被测量的请求面对冷前缀缓存。漏掉这一步数字会被 radix cache 命中抬高，**而且不会报错**
- **flush 不提供关闭开关**——一旦可选就多出一根不可比轴
- **flush 只打入口 router**。即使被测服务是 PD 分离架构，也只登记一个 router URL

### 5.3 预估耗时

`Cell 数 × (warmup + 测量时长 + flush)`，其中测量时长由 `num_requests` 与最近延迟估算。

必须在点"开始"之前显示在按钮旁边。同一 URL 的任务仍会互相等待，预估耗时帮助用户判断等待成本。

### 5.4 不做 SLO 判定

Cell 只有状态：`idle` / `queued` / `running` / `completed` / `failed` / `cancelled`。

**不判定任何 SLO，不产出 PASS/FAIL，不计算"最高通过档位"。** 拐点由人看曲线判断。Deployment 上不设任何阈值字段，图表上也不画参考线。

### 5.5 进度与取消

- **进度粒度是 Cell**：展示"正在跑第 3/8 个 Cell（workload=prefill-1k-128, 并发=16）"
- **不做请求粒度的实时曲线**：单点只跑几十秒，实时数字没有决策价值
- **支持取消**：`kill` 子进程组，Cell 置为 `cancelled`，**已完成 Cell 的结果保留**
- 终态写入用 SQL 条件写入（`WHERE status NOT IN (...)`）消除取消与监督线程之间的 TOCTOU

### 5.6 巡检的执行

当前用例集共 17 项，不维护或展示版本号。内置默认选中 13 项，客户端中断场景、长输入处理、长输出生成、高并发稳定性为按需选择。新服务使用配置管理中的默认选择，已保存的选择和历史记录保持原样。

高并发稳定性：每个请求使用不同随机数据，消息 tokenizer 校准输入到 102400 token（允许向上 0.1% 误差），输出 max_tokens=2048、ignore_eos=true。校验上下文和输出预算及基础接口后，直接启动 64 个流式请求，完成即补充，维持 300 秒；请求超时 180 秒，初始数据准备最多 240 秒。停止补充并收尾后，最多 60 秒验证健康与聊天连续成功 3 轮。整体项目默认超时 900 秒。通过要求完整窗口、峰值 64、窗口平均客户端在途请求数至少 57.6、至少 90% 完成请求的 usage 达到输入/输出目标，且无服务、协议、连接错误并恢复正常。429、参数不支持、计数缺失或负载不足为无法判定；5xx、断流、输出超限或恢复失败为失败；连接异常和超时为执行错误。发现硬错误或限流时停止补充。保存汇总指标、随机输入哈希和有界样本，避免保存全部大输入。缺少可靠上下文或 tokenizer 时跳过，不降低负载。

长序列巡检：输入目标和输出目标均为上下文上限的 90%（向下取整）。长输入使用消息 tokenizer 搜索目标长度，允许最多上下文的 0.1% 误差（最少 1 token），预留最多 64 token 回复空间；长输出先计数短输入，再请求 90% 上下文的输出，读取流式 completion_tokens 确认覆盖。均要求输入加输出预算不越界。缺少上下文或 tokenizer 时跳过；输出上限不足、提前正常结束、缺少可靠计数时无法判定，不静默降低目标。长输入默认超时 300 秒，长输出 900 秒；超时为执行错误，已收到的原始数据保留在 evidence。

以下三项为可选能力巡检：

- 流式工具调用：按调用 index 拼接函数名和参数，检查唯一调用 ID、函数名、参数类型，以及 `tool_calls` 和 `[DONE]` 结束标记。
- 工具结果回传：先获取真实工具调用，再附带原始 assistant 消息和每个调用对应的模拟 tool 结果回传，使用 `tool_choice=none`，要求后续返回正常结束的非空文本。不会执行外部工具。
- 结构化输出：发送 `response_format=json_schema`、`strict=true`，检查固定的 city 字符串和 temperature 整数字段，两者必填且不允许额外字段。只验证格式，不判断天气事实；完整响应不符合结构判失败，拒绝该能力或回复截断/拒答判无法判定。

以上新增项遇到鉴权、限流等阻断时无法判定，5xx 判失败，连接异常判执行出错。工具能力明确不支持时跳过，未知且未测成功时无法判定；已得到合法工具调用后，回传阶段按已证实的能力判断。协议参考：[工具调用](https://developers.openai.com/api/docs/guides/function-calling)、[结构化输出](https://developers.openai.com/api/docs/guides/structured-outputs)。

目标发现（`/health` → `/v1/models` → `/model_info` → `/v1/tokenize`）→ 按套件顺序执行已选用例，逐条断言、逐条写库 → 汇总结论：

- 任一用例确认契约失败（包括可选能力返回 5xx）→ `FAIL`。
- 没有确认失败，但存在执行异常 → `ERROR`，不等同于服务契约失败。
- 必需用例无法判定或被跳过，或没有任何通过项 → `INCONCLUSIVE`。
- 否则 → `PASS`，只表示本次所选用例的结论。可选能力缺失/未知保留逐项状态。

目标发现失败时记录 `INCONCLUSIVE`；子进程异常记录 `ERROR`。输入校验仅接受结构化 400/422 且错误信息指向被测字段/输入；鉴权、路由或限流错误不能证明输入校验通过。输出上限需要有效 token 计数；上下文溢出先调用 tokenizer 验证实际输入越界。工具调用使用指定函数的 `tool_choice`，避免模型自由选择文本回答干扰协议断言。

每项用例的截止时间覆盖全部请求，不叠加固定 60 秒 HTTP 截止时间。专项扰动无论通过、失败或超时，随后均尝试恢复检查；恢复拥有独立的 30 秒总预算，失败时保留原测试信息。

**巡检不进压测队列，但按规范化 URL 与压测共享目标占用。** 当前单后端进程内，启动检查和目标预留与压测调度使用同一锁。同目标已有任务时，新巡检返回 409；巡检执行期间，同目标压测等待。占用持续到子进程实际退出（包括取消后的退出），随后唤醒等待的压测。不同 URL 可以并行；不同 URL 指向同一底层服务的别名不在此互斥范围内。

---

## 6. 测量口径

**这些定义必须固定下来，任何一处不一致都会导致"数字看起来合理但系统性偏移"。**

### 6.1 计时

| 指标 | 定义 |
|---|---|
| **计时起点** | **HTTP 请求真正发出的那一刻**。排队等待并发许可的时间**不计入** |
| **TTFT** | 起点 → **第一个非空文本增量**（`content` 或 `reasoning_content`）。注意不是"第一个 chunk" |
| **E2E** | 起点 → 响应流结束 |
| **TPOT** | `(E2E − TTFT) / (completion_tokens − 1)`；当 `completion_tokens ≤ 1` 或 `E2E < TTFT` 时**无值**（不是 0） |

**已知口径后果**：高并发档位下呈现的是**服务时间**，而非用户感知的响应时间。界面必须说明这一点。

### 6.2 百分位

**使用 numpy 的线性插值**（`numpy.percentile` 默认行为）。

### 6.3 合成 Workload 的生成上限

合成 Workload 的输入 token 数在**创建 Cell 时校验**：不得超过所属 Deployment 的 `synthetic_input_limit`（带合理默认值的可配参数）。

理由：`max_model_len` 是模型的**能力上限**，不是压测的**合理工作点**。目标服务 `DeepSeek-V4-Flash-0731` 的 `max_model_len = 1048576`，不封顶的话会有人配出百万 token 的输入——约 4MB 的 JSON、单请求以分钟计。Workload 进了全局库之后本身不知道会被哪个 Deployment 引用，所以上限校验发生在 Cell 一侧。

### 6.4 端点选择

| Workload 种类 | 端点 |
|---|---|
| synthetic | `POST /v1/completions` |
| dataset（业务数据集） | `POST /v1/chat/completions` |

### 6.5 业务数据集

**数据集是后端同机上的文件，在配置文件中登记**（不通过网页上传）：

```json
{
  "datasets": [
    {"name": "claw", "path": "/data/datasets/claw.jsonl"},
    {"name": "muses-v4-flash", "path": "/data/datasets/muses-v4-flash.jsonl"}
  ]
}
```

格式为 JSONL，每行一个 payload 对象（含 `messages` 或 `prompt`）。数据集文件缺失或格式不合法时在**创建 Cell 之前**报错，而不是排完队才失败。**数据集视为预置且不变，不做内容哈希校验**（ADR-0001）；执行时可将 sha256 记入产物供审计，但它不参与可比性判定。

---

## 7. API 草图

```
GET    /api/models
POST   /api/models
GET    /api/models/{id}
PATCH  /api/models/{id}

GET    /api/models/{id}/deployments
POST   /api/models/{id}/deployments
GET    /api/deployments/{id}
PATCH  /api/deployments/{id}

# Workload 全局库
GET    /api/workloads
POST   /api/workloads                      # 恰好二选一：tokens 或 dataset
PATCH  /api/workloads/{id}                 # 仅名称与备注
DELETE /api/workloads/{id}                 # 被 Cell 引用时 409

# Cell
GET    /api/deployments/{id}/cells
POST   /api/deployments/{id}/cells         # body: workload_id, mode, levels[], num_requests
                                           # 展开成多个 Cell；重复 (mode, level) → 409
PATCH  /api/cells/{id}                     # 仅 num_requests；改后未重跑时界面提示
DELETE /api/cells/{id}
POST   /api/cells/{id}/run                 # 运行中 → 409
POST   /api/cells/run                      # 批量：body 为 cell_ids[]
GET    /api/cells/{id}                     # 状态 + 最新结果 + 执行快照
POST   /api/cells/{id}/cancel
GET    /api/cells/{id}/artifacts           # 产物下载
GET    /api/estimate?cell_ids=             # 预估耗时

# 对比：按 workload_id + (mode, level) 自动对齐，只比交集
GET    /api/compare?model_id=&deployment_ids=

# 巡检（独立，不变）
GET    /api/services
POST   /api/services
GET    /api/services/{id}
GET    /api/services/{id}/inspections
POST   /api/services/{id}/inspections
GET    /api/inspections/{id}
```

> 子进程写库为主（§2.3），进度字段由子进程直写，前端轮询读取。

---

## 8. 对拍方案（自研路线的安全网）

**已通过（工单 02），重构不影响其有效性**——负载发生器本身没有变，变的只是它上面的编排层。

自研负载发生器最危险的不是"跑不起来"，而是**跑起来了、数字看起来合理、但系统性偏移**——比如 TTFT 起点差了一次事件循环、TPOT 少减一个 1、百分位用错插值。这类错误**不会报错**，只会在几个月后以"数据好像不太对"的形式发作。

### 8.1 对拍定义

**同一个 target、同一份配置，本站负载发生器与 `aib` 各跑一次**，以下指标必须在统计噪声内一致：TTFT / E2E / TPOT 的 p50 与 p99、输出吞吐、成功率。

### 8.2 不建 mock 目标服务

**不建 mock server。** 一个错误的 mock 会给出**虚假的安心**——它按你理解的协议回包，而你写的解析器也按同一理解写，两边一起错、测试全绿。真实目标不会附和你的误解。

离线只测纯函数：SSE 解析（构造的字节分片）、TPOT 公式、直方图与百分位、巡检断言谓词。编排时序（warmup → flush → 计时）用**进程内替换依赖**的方式测事件顺序。

### 8.3 对拍同时是唯一的集成测试

因为不建 mock，对拍是验证负载发生器、编排时序、flush 契约、SSE 解析在**真实协议**下都正确的**唯一**手段。

---

## 9. 页面清单

```
首页 → Model 列表

Workload 库（全局入口）
├── Workload 列表（名称 · 种类 · 形状 · 被引用数）
└── [新建 Workload]：选种类 → 合成填 tokens / 数据集选已登记名称

Model 详情页
├── Deployment 列表（名称 · router URL · Cell 完成情况）
├── [新建 Deployment]
└── [对比] ← 勾选 2+ 个 Deployment

Deployment 详情页（浅灰底白卡；Workload 卡片自适应网格：一行最多 3 张，宽度不足时降为 2 张或 1 张；卡片内的模式面板在卡片足够宽时并排、过窄时上下堆叠）
├── 配置区 + 运行摘要（N 项运行中 · M 项待运行）
├── [添加负载] → 从 Workload 库选择，或当场新建入库（不配压测参数）
├── 每个 Workload 一张全宽卡片（圆角 18px、浅边框、轻阴影）：
│   ├── 头部：名称 · 形状（等宽数字）· [＋ 添加测试] → 选模式 + 档位列表 + 请求数（单值广播 / 多值一一对应）
│   ├── 「并发测试」「QPS 测试」两面板左右等宽并排（竖分隔线），各带数量徽标与 [运行剩余 N 项]
│   └── 面板内固定四列：参数 · 状态 · 进度/请求数 · 操作；行内图标操作（运行/重跑/停止/⋯），
│       ⋯ 收编辑参数/复制/删除；运行中行淡蓝底 + 细进度条；状态为圆点+文字（待运行灰、运行中蓝）
└── 结果区：曲线在面板内按 mode 分组（X=档位，对数刻度）；直方图与时延表在行展开详情内
    （配置改过未重跑的行状态列显示"结果来自旧配置"提示）

对比视图（同一 Model 下）
├── 勾选 2+ Deployment 直接进入，无需选 Run
├── 按 (Workload, mode) 分节：交集档位的指标表 + 叠加曲线
├── 某方缺某个点 → 显示"未测"；无共同点 → 明确说明
└── 每个点标注各自的执行时间 ← 读时拼装曲线的缓解

巡检（完全独立的入口，不变）
├── Service 列表
├── [新建 Service]
└── Service 详情页：配置 + [开始巡检] + 巡检历史 + 单次结果（用例红绿灯）
```

---

## 10. 里程碑

| 阶段 | 内容 | 状态 |
|---|---|---|
| **M0** | 自研负载发生器 + 纯函数测试 | ✅ 完成（工单 01），重构不受影响 |
| **M1** | 对拍：与 `aib` 口径一致 | ✅ 完成（工单 02），重构不受影响 |
| **M2** | Model / Deployment 管理 | ✅ 完成（工单 03），重构不受影响 |
| **M3** | **Cell 重构**：数据模型推倒重建 + 单 Cell 执行链路 | 工单 04 |
| **M4** | Workload 全局库 + Cell 批量配置 + 队列/预估/取消 | 工单 05、07 |
| **M5** | Cell 结果图表 + 执行快照 + 对比视图 + 产物 | 工单 06、10、11、12 |
| **M6** | 巡检（已完成，工单 13/14/15） | ✅ 完成，重构不受影响 |

---

## 11. 已知取舍与风险

| # | 事项 | 状态 |
|---|---|---|
| 1 | **自研负载发生器的口径偏移风险** | 已由对拍缓解（工单 02）。这是本项目最大的技术风险 |
| 2 | 高并发下显示的是服务时间，非用户感知响应时间 | 已知口径，界面说明 |
| 3 | 无逐请求明细进库，无法从数据库回溯"最慢的请求" | 已接受；逐请求 JSONL 落产物目录（§4.3） |
| 4 | 后端与子进程都可写库 | 由写入所有权分离约束（§2.3），SQLite 开 WAL |
| 5 | 压测与巡检需两处各配一次 URL | 已接受（§3.1） |
| 6 | 同一 URL 的长任务会阻塞该目标上的其他任务 | 由预估耗时显示缓解（§5.3）；不同 URL 可并行，Cell 粒度让单点重跑快进快出 |
| 7 | **无执行历史：趋势与回归追踪不可做，误触重跑不可恢复** | 已接受（ADR-0001）；执行快照承担配置漂移提示 |
| 8 | **曲线读时拼装，各点可能跑于不同时间/条件** | 已接受（ADR-0001）；界面标注每点执行时间 |
| 9 | 不建 mock 服务导致离线测试能力收窄 | 已接受。离线只测纯函数，对拍是唯一的集成测试（§8） |
| 10 | 业务数据集变更靠改配置文件 | 已接受；数据集视为预置不变，不参与可比性判定（§6.5） |
