# 13: 巡检第一刀：登记服务 + 最小用例集 + 红绿灯

**What to build:** 一个**完全独立**的巡检入口：登记一个 Service（名称、router URL、API key 环境变量名、备注），点【开始巡检】跑目标发现与最小用例集，页面显示逐条用例的通过/失败。

**Blocked by:** 01, 03

**Status:** done

- [x] 巡检与压测在数据与页面上**完全独立**，不共享任何实体、不互相引用
- [x] Service 只需四个字段即可创建
- [x] 目标发现：`/health` → `/v1/models` → `/model_info` → `/v1/tokenize`；发现失败则 Inspection Run 置为 failed
- [x] 跑通非流式 completion 用例
- [x] **`INCONCLUSIVE` 与 `FAIL` 从第一天就分开**：前者是"测不出来"，后者是"服务违反了契约"，绝不合并
- [x] Inspection Run 记录**用例套件版本**——套件版本不同，两次巡检结果不可比
- [x] 只记录 API key 所在的环境变量名，不存密钥

## 验证记录

后端 65 个测试（48 个引擎规则 + 17 个接口）+ 前端 11 个。**通过 API 真跑一次巡检**（子进程）：

```
inspection #1  status=completed  verdict=PASS  suite_version=3  pid=986344
目标: DeepSeek-V4-Flash-0731  context=1048576  tools=supported
      thinking=supported  引擎=sglang
```

### 两个系统，一张表都不共享

`service` / `inspection_run` / `inspection_case_result` 与 `model` / `deployment` / `run` 完全分开。Service 也没有 `model_name`、没有拓扑、没有生成上限——巡检不需要它们，要了就是在问错的问题。有测试断言 `Created service` 里不存在这些字段，也有测试断言两边互不可见。

### 巡检不进压测的队列

压测的全局串行队列存在，是因为两台负载发生器打同一台服务会互相污染数字。巡检**刻意不走这条队列**：它很短，而它的全部价值就是回答"这个服务**现在**还好吗"——排在一次四十分钟的扫描后面，这个价值就没了。有测试钉住。

### 发现失败 = 巡检失败，不是用例失败

`/health` 不通、`/v1/models` 说不清有哪个模型，这些都发生在任何用例能跑之前。此时 Run 置为 `failed` 并记下原因，而不是伪造一组用例结果。

### 三态而不是布尔

`unknown`（服务没声明）与 `unsupported`（服务说不支持）走的是不同的分支、得到不同的判定。把它们当成一回事，是最容易造出假警报的地方。
