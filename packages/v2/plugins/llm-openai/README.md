# OpenAI 协议提供者

`createOpenaiPlugin({ api, token, baseUrl, apiKey, models, limits?, headers?, fetch?, now? })` 返回插件 Result。`api` 必须显式选择 `responses` 或 `chat-completions`。同一种协议可创建多个独立 endpoint/凭据插件，分别提供不同 token。安装方式见 [LLM](../llm/README.md)。

`models` 是明确允许的模型与能力表，默认只声明文本输入/输出和客户端工具。图片、文件、结构化输出、引用及推理需显式配置；不根据模型名字推测能力或上下文窗口。`maxOutputTokens` 同时是已知上限与省略请求参数时的配置值；请求不能超过该上限。请求中的采样零值不会被默认值覆盖。

Responses 支持文本、URL/base64 图片、PDF/file-id/URL 文件、函数工具、JSON/schema、推理摘要与加密 continuation，以及声明式 `web-search`/`file-search`。检索索引由宿主预先管理。Chat 支持文本、图片、文件、并行函数参数增量、拒绝和 JSON/schema；兼容端点的文本推理字段需在能力表中声明。协议不支持的输入、推理预算或选项返回 `unsupported-feature`，不修改消息来凑请求。

Responses 的普通 assistant 历史以 input_text 回传；缺少完整原生消息身份的 refusal 历史明确 unsupported，不伪造上游 messageId。拒绝输出仍完整保留；应用若只需保留其文字，可显式转换为 text。

两个协议都发送单次流式 POST，无自动重试或 SSE 重连。Chat 收到 finish_reason 后继续等待用量尾帧及 DONE/合法 EOF。Responses 必须有完成/截断/失败证据，最终全文与增量精确核对，只补发完整快照明确包含的后缀；不猜测重叠。工具参数由 LLM 统一层在完成时只解析一次。原生服务器工具只作为有界 provider 内容，不能被当作客户端工具执行。

工具业务错误 `isError:true` 在 Chat 和 Responses 的工具结果内容前增加文本块 `{"isError":true}`，随后保留原始内容及顺序。这是应用层的可见错误标记，不是协议原生字段；模型可以据此修正后续动作。成功回执不增加标记，Chat 仍只接受文本工具结果，Responses 保留原生文本与图片。原始消息及持久检查点保留结构化 `isError`，标记数量受输入消息预算约束。

身份、终态、usage、来源引用、断流及结构化输出在真实回环 HTTP 测试中验证。协议依据：[OpenAI 官方流事件](https://developers.openai.com/api/reference/resources/responses/streaming-events)、[Chat 流事件](https://developers.openai.com/api/reference/resources/chat/subresources/completions/streaming-events)、[结构化输出](https://developers.openai.com/api/docs/guides/structured-outputs)。默认门禁不调用付费接口；特定模型的在线能力需在部署环境验证。
