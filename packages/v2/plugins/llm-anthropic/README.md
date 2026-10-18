# Anthropic Messages 提供者

`createAnthropicPlugin({ token, baseUrl, apiKey, models, limits?, headers?, fetch?, now? })` 返回插件 Result。安装方式见 [LLM](../llm/README.md)。`baseUrl` 包含版本路径，例如 `https://api.anthropic.com/v1`；认证和协议头由插件发送。

模型能力由宿主显式配置。`maxOutputTokens` 或请求中的 `maxOutputTokens` 必须提供，插件不猜测模型上限。支持文本、URL/base64 图片、text/PDF/URL 文档、搜索结果、客户端函数工具、JSON Schema、引用、思考签名和原生续接。默认仅声明文本及客户端工具，未声明的能力在网络请求前拒绝。

`reasoning.budgetTokens` 选择模型支持的固定预算，必须至少 1024 且小于本次输出限额；省略预算则请求 adaptive。`effort` 按能力表允许的值发送。`display: summary` 显式请求原生 summarized，`display: hidden` 请求 omitted；签名及空 thinking 块仍原样保存为 continuation。公开推理块标为 summary/hidden，不将思考摘要冒充完整推理。用量中包含缓存输入总量，缓存读写与 thinking token 为其明细。

JSON/schema 与引用不能混用。同一请求的所有 document 必须同时启用或同时关闭引用，所有 search-result 也分别要求开关一致；不擅自替调用方打开引用。工具结果含 search-result 时，内容必须全部为 search-result，不能夹杂普通文本/图片；非法组合在发送前明确拒绝。developer、通用 JSON 模式、file-id 文档及不支持的 providerOptions 返回 `unsupported-feature`。system 消息必须位于对话开始处；相邻的工具结果按协议归入同一 user turn，保留各自 callId 和 isError。

同一解析器处理 message_start、内容增量、signature、message_delta 和 message_stop；缺少结束证据的 EOF 为错误。结束原因区分工具、输出截断、上下文截断、暂停及拒绝。工具调用不在本包执行，暂停不自动续发第二次请求。

依据：[官方流协议](https://platform.claude.com/docs/en/build-with-claude/streaming)、[思考](https://platform.claude.com/docs/en/build-with-claude/thinking)、[结构化输出](https://platform.claude.com/docs/en/build-with-claude/structured-outputs)、[搜索结果](https://platform.claude.com/docs/en/build-with-claude/search-results)。默认门禁使用真实回环 HTTP，不代表特定线上模型的在线认证。
