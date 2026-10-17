# LLM 方案审查记录

2026-10-17。状态：讨论稿已完成独立方案审查，尚未实施。审查者只读文档及公开内核生命周期，未修改生产代码、未运行生产测试。

| 确认问题 | 方案处置 | 复核 |
| --- | --- | --- |
| schema请求的stream可能先finish成功，generate随后才发现输出无效 | DESIGN§4/§6：共同运行路径在公开finish之前解析/校验，同一响应必须得到相同成功判断；VERIFICATION补成对断言 | 已闭合 |
| 引用只有输出事件，缺少触发原生引用的输入及互斥组合 | DESIGN§4：document/search-result与citations、显式Responses引用工具、source映射；Anthropic引用与schema组合预检；旅程同时验证请求与输出 | 已闭合 |
| 结束后关闭reader，却承诺检出未来任意尾字节 | DESIGN§6/§8：规范化层终态封口；网络只校验已解码帧和协议终止边界；Chat允许usage尾阶段；关闭后未来未读字节不承诺检出 | 已闭合 |
| file_search检索文件未必有输入sourceId，不能伪造本地文档身份 | LlmCitation独立file分支保留provider/protocol/fileId，输入文档仍用sourceId；验证无document输入、仅vector store ID且引用多个检索文件 | 已闭合 |

末轮复核确认上述四项闭合。未发现固定提供者依赖映射与core权限/实际工作排空间的确定矛盾。实现后的资源、协议、并发与性能仍须按VERIFICATION.md重新验证，不能以方案审查代替实际门禁。

用户已裁决三协议及首批模态；服务/消息细节与预算为可讨论的设计建议。方案保持草稿，避免将尚未与用户讨论的API细节标为用户已逐项确认。
