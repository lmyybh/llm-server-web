# 01: 测量内核：对真实目标跑出可信的逐请求指标

**What to build:** 一个能对真实 Target Service 发起负载、并产出可信指标的最小测量能力：增量 SSE 解析、逐请求 TTFT 与 E2E 计时、TPOT 计算、闭环保并发、结果聚合（直方图 + 分位数）。交付一个最小的命令行入口，对一个 workload 的一个档位跑一次并输出指标。

**Blocked by:** None（可立即开始）

**Status:** done

- [x] SSE 解析器能正确处理：事件被切在 UTF-8 多字节中间；多个事件挤在一个网络 chunk；单个事件跨多个 chunk；多行 `data:` 拼接；`[DONE]` 终止
- [x] 计时起点是**请求真正发出的时刻**，排队等待并发许可的时间不计入
- [x] TTFT 为起点 → **第一个非空文本增量**（不是第一个 chunk）；E2E 为起点 → 响应流结束
- [x] TPOT = (E2E − TTFT) / (completion_tokens − 1)；当 completion_tokens ≤ 1 或 E2E < TTFT 时**无值而非 0**
- [x] 百分位使用 numpy 线性插值
- [x] 闭环模式下并发上限被严格遵守
- [x] 对真实目标跑一次，输出 TTFT / TPOT / E2E 的 p50、p95、p99，输出吞吐、成功率，以及按档的直方图

## 验证记录

**68 个单元测试**（`backend/tests/`，pytest）。

**真实目标跑通**，`concurrency=8 / 64 requests / input=1024 / output=128`，64/64 成功：

```
ttft_ms   p50 788.69   p95 801.24   p99 805.87
tpot_ms   p50  13.07   p95  13.38   p99  13.40
e2e_ms    p50 2446.79  p95 2487.26  p99 2487.94
output tput 417.94 tokens/s   achieved 3.27 req/s
finish reasons {'length': 64}
```

**两处自洽性核对**（这是目前对计时正确性最有力的证据）：

| 核对 | 结果 |
|---|---|
| `TTFT + (completion_tokens − 1) × TPOT` vs `E2E` | `788.69 + 127 × 13.07 = 2448.6` vs `2446.79` — 差 1.8ms |
| `E2E_p50 × ⌈requests/concurrency⌉` vs `duration` | `2.44679 × 8 = 19.574s` vs `19.60s` — 差 26ms，**证明并发上限生效** |

**实现中的两个判断**（不属于验收项，但值得记下）：

1. **流被中途切断时，未终结的尾行被丢弃，不做半解析。** 这会把失败变成可见的 `stream_ended_without_done`，而半解析要么给出令人困惑的 malformed 错误、要么在残缺 JSON 上意外成功。
2. **三个指标各用各的分桶边界。** 原先共用一套，导致 TTFT/TPOT/E2E 只有一个能有分辨率（设计文档 §4.2 本就写的是"同一**指标**使用同一套分桶边界"）。趁无历史数据时已改正——边界一旦有数据落库就不能再动。

**尚未做**：与 `aib` 的对拍（工单 02）。本工单只证明"跑得通且内部自洽"，不证明"与既有口径一致"。

## 目标服务的实测形状

Target Service: `http://maas-infer-service-wlcb-gray-dpsk-v4-flash-default-alb-pre.kanzhun-inc.com`
模型 `DeepSeek-V4-Flash-0731`，SGLang **统一引擎**（非 PD 分离），`max_model_len = 1048576`。
`tool_call_parser = deepseekv4`、`reasoning_parser = deepseek-v4`（两者能力均为 supported）。
`/health` 往返约 **1.03s**（ALB 入站开销），探针超时要留余量。

**从真实流里抓到的 6 个解析陷阱——每一条都属于"看起来对、数字错了、但不报错"：**

1. **usage 挂在每个 chunk 上，且是累计值**（`completion_tokens` 依次为 1、2、3）。必须取最后一个，**绝不能累加**——累加会静默得到 6 而非 3
2. **最后一个事件的 `choices` 是空数组**。无条件 `choices[0]` 会崩
3. **每个 delta 都带 `reasoning_content: null`**。判断"有没有推理内容"必须判**值非空**，不能判 key 是否存在——否则每个请求的第一个事件都会误触发 TTFT
4. **第一个事件的 `content` 是空串 `""`**。TTFT 必须在第一个**非空**增量触发——这条定义现在有实证支撑
5. **`prompt_tokens_details` 是 `null`**，即使显式传了 `return_cached_tokens_details: true`。提取 `cached_tokens` 必须能吞掉 null，且**不能把 null 当 0 参与比率计算**（否则得到 0/0）
6. **`finish_reason` 出现在只有 `{"reasoning_content": null}` 的事件里**，该 delta 连 `content` 键都没有

另：`/v1/tokenize` 对同一句话返回 `count: 7`，而 completion 报 `prompt_tokens: 9`——两者不是一回事，构造超长输入时要留余量。
