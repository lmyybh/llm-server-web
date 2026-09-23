# 14: 巡检扩展用例

**What to build:** 补齐巡检用例集：流式、三类非法请求、输出长度限制、context overflow、工具调用、thinking 开关。

**Blocked by:** 13

**Status:** done

- [x] 流式用例：校验 `[DONE]`、事件均可解析、finish_reason 合法
- [x] 三类非法请求（畸形 JSON、缺 messages、字段类型错）都要求**结构化的 4xx**；接受请求、返回 5xx 或断开连接都算失败
- [x] 输出长度限制（max_tokens=1）被正确遵守
- [x] context overflow：仅在 context_length 可知且 tokenizer 可用时执行；必须被**结构化拒绝**
- [x] 工具调用与 thinking 开关按能力三态处理：`supported` 时协议错误算 FAIL；`unsupported` 时 SKIPPED；`unknown` 时做安全探测
- [x] **5xx、连接中断、或污染后续请求的探测，绝不能被读成"不支持该能力"**
- [x] 覆盖 `/health` 与 `/health_generate`——**健康检查通过但实际无法生成**是最值得抓的一类故障
- [x] 汇总规则：任一**必需**用例 FAIL/ERROR → Run FAIL；否则任一必需用例 INCONCLUSIVE → Run INCONCLUSIVE；否则 PASS
- [x] 非必需的用例无论结果如何都不改变 Run 的 verdict

## 验证记录

11 个用例对真实目标全部通过。

### 结构化拒绝的两种形状

`_safe_rejection` 接受两种错误体：`{"error": {...}}`（OpenAI 惯例）和 `{"object": "error", "message": "...", "type": "..."}`（**SGLang 的顶层形状**）。只认前者会把 SGLang 合法的拒绝判成失败——一条针对该形状的测试专门钉住这点。

非 4xx 一律不算拒绝：200 是纵容，5xx 是崩了，连接断开是失联。三者与"明确拒绝"都不是一回事。

### 5xx 绝不能被读成"不支持"

这是最容易造出**假绿**的一条：服务崩了，工具却写成"该能力不支持，跳过"，用户看到一片绿。

所以 `extensions.*` 用例里的判断顺序是：**先看 5xx → FAIL**，再看 4xx → 才轮到能力判断。有测试覆盖。

### `unknown` 是探测，不是拒绝

服务没声明能力时，用例仍会**发一次安全探测**：真的不支持 → SKIPPED；答得含糊 → INCONCLUSIVE；答得对 → PASS。只有服务**明确说不支持**才直接 SKIPPED。

### `/health_generate` 是必要不充分

它单独不能证明服务能生成（设计文档里的教训），所以它只是用例集里的**一个**用例，真正的证明来自后面那些真实生成请求。

### 适用性由事实决定，不由参数决定

`context.overflow` 只在 context 长度可知**且** tokenizer 可用时才跑，否则记 `SKIPPED / not_applicable`。凑一个超长请求去打不知道长度的服务，测的是猜。
