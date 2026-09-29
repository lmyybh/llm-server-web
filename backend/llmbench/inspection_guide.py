"""User-facing explanations of the built-in inspection cases."""

CASE_GUIDE = {
    "context.long_input": {
        "description": "以 90% 上下文长度的输入检查长输入处理，默认按需开启。",
        "steps": ["读取上下文上限，用消息 tokenizer 构造占上限 90% 的输入（误差不超过上下文的 0.1%，最少 1 token）。",
                  "预留最多 64 个输出 token，确认输入加输出预算不超限，再请求简短回复。"],
        "pass_rule": "输入达到目标，响应合法、非空并正常结束。",
        "fail_rule": "已确认预算未越界但被明确以超上下文拒绝、返回 5xx 或响应损坏。",
        "other_rule": "缺少上下文上限或 tokenizer 则跳过；构造不到目标、短回复被截断或其他拒绝时无法判定；连接或超时为执行出错。",
        "endpoint": "POST /v1/tokenize → /v1/chat/completions"
    },
    "output.long_generation": {
        "description": "目标输出为上下文上限的 90%，检查长时间流式生成，默认按需开启。",
        "steps": ["目标输出设为上下文上限的 90%，先计数短输入并检查总预算。",
                  "流式请求 max_tokens=目标值并要求用量统计；不静默降低目标。",
                  "检查结束标记与 completion_tokens，实际长度采用服务报告的计数。"],
        "pass_rule": "实际输出达到目标，流式数据合法且完整结束。",
        "fail_rule": "返回 5xx、流式格式损坏、缺少结束标记或实际输出超过请求上限。",
        "other_rule": "缺少前提则跳过；独立输出上限不足、提前结束、缺少计数或请求拒绝时无法判定；连接或超时为执行出错。",
        "endpoint": "POST /v1/tokenize → /v1/chat/completions · stream=true"
    },
    "extensions.tools_stream": {
        "description": "检查流式工具调用的分段参数能否正确拼接。",
        "steps": ["开启流式输出，指定调用 get_weather 工具。",
                  "按调用编号拼接函数名和参数，检查调用 ID、参数和结束标记。"],
        "pass_rule": "所有调用 ID 唯一，函数名正确，city 是字符串；收到 tool_calls 和 [DONE]。",
        "fail_rule": "已声明工具能力但格式、参数或结束标记不符合要求，或返回 5xx。",
        "other_rule": "明确不支持则跳过；能力未知且未测成功、鉴权或限流阻断时无法判定；连接失败或超时为执行出错。",
        "endpoint": "POST /v1/chat/completions · stream=true"
    },
    "extensions.tools_roundtrip": {
        "description": "检查工具调用结果回传后，模型能否继续正常回复。",
        "steps": ["指定调用 get_weather，获取合法的工具调用和唯一 ID。",
                  "为每个调用生成模拟天气结果，连同原始 assistant 消息及匹配的 tool_call_id 回传。",
                  "关闭后续工具调用，检查模型返回正常文本；不实际调用外部工具。"],
        "pass_rule": "首轮工具调用合法，回传后得到正常结束的非空文本回复，不要求回答文字完全固定。",
        "fail_rule": "已声明支持但首轮调用不合法，或合法调用回传后响应不符合要求，或返回 5xx。",
        "other_rule": "明确不支持则跳过；首轮能力未知且未测成功、鉴权或限流阻断时无法判定；连接失败或超时为执行出错。",
        "endpoint": "POST /v1/chat/completions × 2 · 共用项目超时"
    },
    "extensions.structured_output": {
        "description": "检查严格 JSON 结构输出的字段、类型和必填项。",
        "steps": ["使用 response_format=json_schema 和 strict=true。",
                  "要求返回 city 字符串和 temperature 整数，两个字段必填，不允许额外字段。",
                  "解析完整回复并检查固定结构，不检查实际天气是否准确。"],
        "pass_rule": "正常结束，返回可解析的 JSON 对象，且字段和类型全部符合指定结构。",
        "fail_rule": "接受请求并完整回复，但 JSON、字段或类型不符合要求，或返回 5xx。",
        "other_rule": "拒绝该能力、鉴权或限流阻断、模型拒答或输出截断时无法判定；连接失败或超时为执行出错。",
        "endpoint": "POST /v1/chat/completions · response_format=json_schema"
    },
    "health.generate": {
        "description": "检查服务自带的生成健康入口。",
        "steps": [
            "请求 /health_generate，等待服务响应。"
        ],
        "pass_rule": "返回 HTTP 200。",
        "fail_rule": "返回其他 HTTP 状态码。",
        "other_rule": "连接失败或超时显示执行出错。",
        "endpoint": "GET /health_generate"
    },
    "completion.non_stream": {
        "description": "确认普通聊天请求能返回完整、合法的响应。",
        "steps": [
            "发送“Reply with pong.”，关闭流式输出。",
            "检查回复结构、用量字段和结束原因，不核对回答是否为 pong。"
        ],
        "pass_rule": "HTTP 200，包含 choices、message、usage，结束原因合法。",
        "fail_rule": "回复结构不完整或 HTTP 状态异常。",
        "other_rule": "连接失败或超时显示执行出错。",
        "endpoint": "POST /v1/chat/completions"
    },
    "streaming.basic": {
        "description": "检查流式数据能被解析，并明确结束。",
        "steps": [
            "开启流式输出，发送“Reply with pong.”。",
            "逐条解析事件，检查结束原因和 [DONE]。"
        ],
        "pass_rule": "收到可解析事件、合法结束原因及 [DONE]。",
        "fail_rule": "事件格式错误、缺少事件或结束标记。",
        "other_rule": "连接失败或超时显示执行出错。",
        "endpoint": "POST /v1/chat/completions"
    },
    "validation.malformed_json": {
        "description": "发送不完整的请求，检查服务能否正确拒绝。",
        "steps": [
            "发送不完整的 JSON：{\"model\":。"
        ],
        "pass_rule": "结构化 400/422，错误指向 JSON 解析。",
        "fail_rule": "请求被接受，或服务返回 5xx。",
        "other_rule": "鉴权、限流或拒绝原因不明时无法判定。",
        "endpoint": "POST /v1/chat/completions"
    },
    "validation.missing_messages": {
        "description": "检查聊天接口是否校验必需字段。",
        "steps": [
            "从正常聊天请求中删除 messages 字段。"
        ],
        "pass_rule": "结构化 400/422，错误指出 messages。",
        "fail_rule": "请求被接受，或服务返回 5xx。",
        "other_rule": "未能确认是缺失字段导致拒绝时，无法判定。",
        "endpoint": "POST /v1/chat/completions"
    },
    "validation.wrong_field_type": {
        "description": "检查参数类型错误是否得到明确提示。",
        "steps": [
            "把 temperature 改成字符串 \"hot\" 后发送。"
        ],
        "pass_rule": "结构化 400/422，错误指出 temperature。",
        "fail_rule": "请求被接受，或服务返回 5xx。",
        "other_rule": "未能确认拒绝原因时，无法判定。",
        "endpoint": "POST /v1/chat/completions"
    },
    "output.small_limit": {
        "description": "检查 max_tokens 是否限制了生成长度。",
        "steps": [
            "发送 max_tokens 为 1 的聊天请求。",
            "读取服务返回的 completion_tokens，不独立重算输出 token。"
        ],
        "pass_rule": "回复正常，completion_tokens 为整数 0 或 1。",
        "fail_rule": "生成超过 1 个 token，或响应不符合要求。",
        "other_rule": "token 计数缺失或不可用时，无法判定。",
        "endpoint": "POST /v1/chat/completions"
    },
    "context.overflow": {
        "description": "确认超长输入被明确拒绝。",
        "steps": [
            "构造长文本，先用 tokenizer 确认输入超过上下文长度。",
            "确认越界后，再发送聊天请求。"
        ],
        "pass_rule": "结构化 400/422，错误指向上下文或长度。",
        "fail_rule": "接受超长输入，或返回 5xx。",
        "other_rule": "缺少上下文长度或 tokenizer 时跳过；未证明越界时无法判定。",
        "endpoint": "POST /v1/tokenize → /v1/chat/completions"
    },
    "extensions.tools": {
        "description": "检查指定工具调用的返回格式。",
        "steps": [
            "提供 get_weather 工具，询问巴黎天气。",
            "使用 tool_choice 指定函数，检查函数名和 city 字符串参数。"
        ],
        "pass_rule": "返回合法工具调用，结束原因为 tool_calls。",
        "fail_rule": "已声明支持却返回不合法调用，或返回 5xx。",
        "other_rule": "未声明能力且未测成功时，无法判定。",
        "endpoint": "POST /v1/chat/completions"
    },
    "extensions.thinking": {
        "description": "检查开启和关闭思考是否产生预期差异。",
        "steps": [
            "对相同请求分别开启和关闭思考。",
            "检查两次响应中的 reasoning_content 字段。"
        ],
        "pass_rule": "开启时有思考内容，关闭时没有，两次格式正常。",
        "fail_rule": "已声明支持但开关行为不符，或出现错误响应。",
        "other_rule": "未声明能力且未观察到开启效果时，无法判定。",
        "endpoint": "POST /v1/chat/completions × 2"
    },
    "stability.high_concurrency": {
        "description": "用 100K 随机输入、2K 输出持续检查高并发稳定性，默认不选中。",
        "steps": [
            "校验上下文至少 104448 token，健康、普通聊天和流式聊天正常。",
            "为每个请求生成不同随机数据，用消息 tokenizer 校准到 102400 token（允许向上 0.1% 误差）。",
            "直接启动 64 个流式请求，设置 max_tokens=2048、ignore_eos=true；完成后补充新请求，持续 5 分钟。",
            "每个请求最多 180 秒；停止补充后等待在途请求结束，再用最多 60 秒验证健康和聊天连续成功 3 轮。"
        ],
        "pass_rule": "完成 5 分钟，峰值达到 64、平均在途请求数至少 57.6，至少 90% 完成请求实际达到 100K 输入和 2K 输出，无服务、协议或连接错误，恢复通过。",
        "fail_rule": "出现 5xx、断流、格式错误、输出超限或恢复失败。",
        "other_rule": "缺少上下文或 tokenizer 时跳过；预算不足、参数不支持、限流或实际负载不足时无法判定；超时、连接异常为执行错误。平均并发指客户端在途请求数。",
        "endpoint": "POST /v1/tokenize → /v1/chat/completions · 64 并发"
    },
    "disruption.abort_storm": {
        "description": "主动断开部分请求，检查其他请求和服务恢复。",
        "steps": [
            "同时发起 24 个待中断流、8 个正常流和 4 个普通请求。",
            "待中断流分别在第 1、16、64 个内容事件后断开，每组 8 个。",
            "随后最多用 30 秒检查恢复，要求健康检查和聊天连续成功 3 轮。"
        ],
        "pass_rule": "预定中断完成，其他请求正常，恢复检查通过。",
        "fail_rule": "正常请求受到影响或观察到恢复失败；保留原始错误。",
        "other_rule": "未能完成预定中断时无法判定；连接或执行异常显示执行出错。",
        "endpoint": "POST /v1/chat/completions · 最多 36 个并发请求"
    }
}
