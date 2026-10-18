# 协议独立对抗审查

审查者：独立只读会话 llm_protocol_review；核对官方协议原文并作微复现，实现者没有代替审查者作关闭结论。

| 问题 | 处置与证据 |
| --- | --- |
| Responses assistant 历史误发 output_text 与不完整 output message | 改 EasyInputMessage/input_text，缺少原生身份的 refusal 历史明确 unsupported。responses-journey 多轮真实 HTTP 和 request-mapping 用例 |
| Anthropic tool_result 中搜索结果混合其他类型 | 发送前拒绝，不删除或改写内容。request-mapping 的 search-result mixed text |
| Anthropic 缓存局部更新误算输入总量，合法 null 被拒绝 | 由此前规范输入扣除旧缓存得 uncached，再折入更新后的独立缓存累计；null 保留已有值。usage.test 的 10+20→10+40 及 nullable 用例 |
| 同类引用开关必须请求级一致 | document 与 search-result 分别核对全开/全关，不跨类型猜限制。request-mapping 全请求表驱动用例 |
| 手动 thinking 不支持 required/命名工具 | 仅固定 budget 模式拒绝，adaptive 正例保留。request-mapping 成对回归 |
| provider-event 冒充标准输出也通过公共 checker | 必填 expected 标准 text/tool-call，要求实际标准输出与慢消费者路径。provider-contract 的伪造元信息、标准工具、错误预期回归 |

审查者复核确认六项全部闭合，未发现对应修改引入的新问题；只读定向运行4文件73例通过，未重新统计覆盖率。

同步核对并落实的原文边界：Anthropic native display summarized/omitted、thinking token 明细、非空初始 thinking 和签名；Responses done 完整载荷与原始分片作精确前缀核对，矛盾失败而非猜测重叠。相关测试位于 responses-journey、text-tracker、messages-journey 和 usage。

原 positive wire 测试曾断言不合法的 Responses assistant output_text 形态；本次按官方输入契约改为 input_text，并补独立多轮旅程及 refusal unsupported 负例。原 thinking budget+effort 负例也按模型声明改为受支持组合正例。未删除断言、跳过测试或降低门槛来接受错误实现。

主源：[OpenAI Responses 类型](https://developers.openai.com/api/reference/typescript/resources/responses)、[Anthropic 引用](https://platform.claude.com/docs/en/build-with-claude/citations)、[搜索结果](https://platform.claude.com/docs/en/build-with-claude/search-results)、[工具选择](https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools)、[思考](https://platform.claude.com/docs/en/build-with-claude/thinking)。
