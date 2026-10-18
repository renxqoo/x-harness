# Sandbox

`createSandboxPlugin({profiles,limits?})` 提供 execution 服务，使用固定的 `@anthropic-ai/sandbox-runtime` 依赖。当前真实后端是 macOS Seatbelt 单进程隔离；其他平台返回 backend-unavailable，不回退到本地执行。完整工具接入示例见 [受控执行](../tools/EXECUTION.md)。

profile 由宿主定义：cwd、readRoots、writeRoots、env、allowEnv、allowedDomains。cwd 与根必须是存在的绝对目录，安装时规范化真实路径，cwd 自动可读，写根也自动可读。默认没有写根、没有网络；网络地址必须显式加入 allowedDomains（普通域名、IPv4 或 `*.example.com`）。HTTP(S)/SOCKS 兼容程序使用 SRT 代理；清空 NO_PROXY，私网地址也走同一规则。不能使用代理的网络客户端可能无法连接。

准备时冻结完整命令、工作目录和环境；可执行文件必须是绝对普通文件，模型只能覆盖 allowEnv 中的变量。环境不继承宿主秘密。运行前检查目录、可执行文件及符号链接身份，可执行文件内容元数据变化返回 target-changed。实际执行附加私有 TMPDIR 和受控代理变量，不能由请求配置扩大文件或网络权限。固定系统运行时与公开证书读取范围出现在 target.restrictions.systemReadRoots 及资源声明中。

每次执行启动独立 SRT worker，避免并发 profile 合并权限。固定适配器只修改识别成功的 SRT profile 字面量，追加文件与网络限制、禁止文件硬链接和派生进程；未知生成格式失败关闭。允许读取符号链接自身来解析 `/var` 等路径，目标数据仍受根限制。运行前扫描用户可读根，发现多硬链接普通文件或超出扫描预算时拒绝执行。系统及执行器自身的代码/依赖禁止命令写入。

单进程限制意味着 shell 管道、后台任务和需要派生进程的程序会失败；简单 exec、文件处理及单进程解释器可以运行。需要不可信多进程程序、CPU/内存配额、虚拟机或多租户隔离时，接入其他 execution 提供者。宿主插件 JavaScript、宿主内核、系统运行时以及同 UID 的外部文件写入者属于可信计算基。该后端不承诺抵御宿主同时恶意改写路径，也不把 Seatbelt 声称为虚拟机。

limits 默认：maxActiveRequests 8、timeoutMs 60000、maxOutputBytes 1048576、maxScanEntries 10000；硬上限分别 128、1800000、16777216、100000。完整环境最多 16 KiB；输出为 stdout+stderr 合计的原始字节与解码字节预算。取消先 TERM、100ms 后 KILL，等待实际进程组与输出结束后释放容量；宿主回执可能更早。每个目标只能执行一次，未开始时 busy 不消耗目标。

Bun 部署需保留完整包目录、sandbox-worker 和依赖，或整体打包。源码/构建入口共用公开契约身份，不支持只拷贝单个 dist/index.js。
