# HTTP / SSE 工具

面向模型协议适配器的共享实现库，不注册额外服务。只从 `src/index.ts` 公共入口导入。

`readHttpOptions` 校验 endpoint、认证和受限自定义头；目标禁止凭据 URL 与重定向。`requestStream` 以标准 fetch 发送单次 POST，核对成功响应的 SSE 类型，使用有界 UTF8/SSE 解析和实际 reader 关闭。取消立即调用 cancel 唤醒待定读取，关闭后释放锁；失败保留首个明确原因。

`createSseParser` 接受字节片段，支持 BOM、CR/LF、跨片段 Unicode、多行 data 与注释，返回有界帧 Result。最终不完整帧不会被凭空补全。协议解码器必须处理终止证据；此库不把 EOF 当成功，不自动重连或重放请求。

HTTP 错误仅保留状态、白名单 code、请求 ID 和有界 Retry-After 提示，不泄漏原始错误正文或凭据。模型协议、工具执行、重试策略和会话持久化归各自插件。
