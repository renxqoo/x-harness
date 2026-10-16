# 插件内核重构实施日志

日期：2026-10-16。范围：packages/v2 独立工作区。

## 保存基线与改动归属

开始实现时工作区已有未提交变更。实施前保存 157 个文件的源码副本与 SHA-256 清单，存放在本机临时目录 plugin-kernel-baseline-j61xaq9d；未使用 stash、reset、checkout 覆盖或其他销毁性 Git 操作。本次没有 commit、push 或 publish。

基线实际通过：26 个文件、283 个用例；19 个编译负例、23 个文档示例；77 个生产源码边界检查；浏览器构建 75 个模块、100.47 KB。覆盖率为语句 90.41%（1717/1899）、分支 88.55%（1168/1319）、函数 96.09%（271/282）、行 96.31%（1333/1384）。

当前 30 个文件、322 个用例；40 个编译负例、24 个文档示例；84 个生产源码边界检查；构建 81 个模块、120.88 KB。最终门禁与覆盖率见 [验收记录](../VERIFICATION.md)。文件数和包体增加，不据此声称源码量更少或性能更快。

## 源码与测试迁移

| 原目录 | 当前职责与位置 |
| --- | --- |
| runtime | foundation 的共享记录、准入和组合类型；注册/工作/资源/装配容器进入对应状态工厂 |
| plugins | assembly；定义引用和消费者关系进入 registry |
| tasks | execution；等待图、任务身份与容量统一维护 |
| scopes、effects | lifetime；范围、资源与关闭屏障 |
| services、chains、guards、events | mechanisms 下的标准协作机制 |
| diagnostics | foundation/create-diagnostics |
| contracts、context | 保留职责；扩展真实类型化作者入口 |

同名行为测试随模块迁移，内部导入同步调整，旧目录不留转发文件。删除 retain-definitions、release-definitions、identify-plugin、queue-mutation、add-wait、collect-handlers、observe-releases、revoke-lease、revoke-provider、report-diagnostic 等重复薄层，其实际状态操作由对应工厂实现。

生命周期改为 setup；声明为命名 token 映射；宿主单 token 登记为 register，插件完整提供为 provide。隐式解释 setup 成功值为 disposer 的行为删除，对应迟到资源断言改由真实 acquire/release 协议验证。非法映射夹具调整为数组，保持实际无效输入断言。

新增 39 个用例：作者入口 20 个、作者回归 15 个、种子模型 3 个、普通服务端组合 1 个。独立类型原型删除，正例直接编译生产入口；没有保留旧入口别名、双轨字段或模拟实现。

## 审查闭环

已修复并加入回归：实时状态 getter、安全名称读取、整批提供预校验、临时租约失败不缓存、清理 resourceOwner、暂存子范围加入事务、失败子范围保留父记录、函数体返回后的子工作准入、清理不继承取消的激活、外部描述器停止宿主后的准入重检、相同 token 重新安装及空提供批次。

六个独立副本上的故障注入全部被行为断言拒绝；突变未进入工作区源码。完整测试无 skip，覆盖率阈值和统计范围保持原有口径。

GC 引用测量的默认 JIT 偶发失败在保存基线与当前实现均可复现。读取 WeakRef 前保存的堆快照中，残留 token 的最短保留路径为 GC roots → DefinitionData → token，没有活跃宿主注册表路径。精确测量子进程关闭 JIT 后连续 200 次通过，强 Set 突变仍失败。没有删除 token 回收断言、增加回收轮数或关闭宿主代替活跃范围检查。

默认 JIT 和无 JIT 精确引用两种一万轮压力检查均通过。默认 JIT 功能测试和真实 HTTP/SQLite 组合通过。未进行 60 分钟持续运行或多轮同条件延迟比较，因此不宣布相应性能和长期高可用认证完成。

## 实现取舍

容器、计数、索引由四个私有工厂持有，对外返回冻结端口。内部记录仍由受限模块协作修改，Kernel 是只读端口组合；没有增加全记录句柄协议或另一个通用关闭元对象。标准协作机制保留在 mechanisms，领域能力外置。当前结构、使用方式及边界以公共文档为准。

## 接口命名实施

按用户确认范围保留 app.use、call.effect、call.spawn；宿主使用 createHost/install/uninstall/close，插件使用 service/handle/on/middleware/guard、addCleanup、startTask、createScope，范围身份为 scopeId/scopeState。资源回调为 open/close，Result 失败字段为 error。没有兼容别名；Guard deny.reason 及业务数据保持原义。

service 只登记服务，handle 只提供 chain 终结者，on/middleware/guard 分别检查事件、链、决策种类。event/guard 在 setup 前通过同一登记协议暂存，成功后批量发布。资源、权限、依赖、回滚和关闭规则保持。

共享检出目录曾出现外部 reset 回写，回写来源未进一步归因。本轮未执行任何 reset。保存命名迁移前的完整源码快照，之后在托管隔离工作树 plugin-api 完成，实现及验证结果再同步回原目录；未提交或推送仓库其他在途变更。

新增 10 个公开 API 运行回归和 15 个编译负例，全部 332 个运行用例、55 个类型负例、24 个文档示例通过。独立副本的四项故障注入全部被断言拒绝。默认 JIT 与精确引用模式各完成一万轮安装、资源取得、调用、卸载、旧门面拒绝与资源计数检查。
