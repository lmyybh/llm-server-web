"""User-facing explanations of the built-in inspection cases."""

CASE_GUIDE = {
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
