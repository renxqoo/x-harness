# Tools 独立实现审查

审查者 tools_code_review；只读，未参与实现。方案审查另见 plan-review.md。问题全部有行为回归，不以导入失败或测试超时作为修复证据。

| 问题 | 修正与见证 |
| --- | --- |
| additionalProperties可夹带未审计子schema | 强制布尔；schema-data 的 additionalProperties cannot smuggle 用例及突变 |
| 全局请求收到取消仍等待不合作作者 | 通用Invocation.cancel发布早回执，实际工作继续占槽；concurrency 的 explicit request abort/timeout |
| progress消费超时回执被实际退出阻塞 | send失败即时返回，finish等待真正结束；progress 的 consumer timeout reaches the author 及突变 |
| 实例级执行预算没有传到工具 | 封印ticket传预算，每工具逐项取更小值；progress 的 instance progress limits 及突变 |
| 短工具期限和卸载无法及时通知外层 | 受管任务回执桥接；concurrency 的 shorter tool deadline / unloading |
| 下层派生cancelled覆盖Scheduler原始timeout | core先存封闭取消原因再abort，后代与等待者继承；注入Scheduler及core nested wait回归 |

最终复核运行原始探针（schema、实例预算、显式abort、consumer timeout、每工具短期限、卸载、注入Scheduler）：均符合预期。不合作函数未退出时activeTasks保留，放行并close后排空。确认不读取外部reason，工作信号reason仍为原生DOMException，无新增确定的隐私、泄漏和首次回执竞态问题。独立定向验证3文件24例通过，该次未采覆盖率。

基准发现工具名read_file/URLFetch等不符合内核插件名词法：工厂使用ASCII字节十六进制安装名，工具名本身保持不变；4个名称回归和区分大小写的审查通过。

假绿审查确认：没有新增skip/only；tools生产源码进入覆盖率include，90/88/95/96阈值未改变；默认required配置合法。取消回执和实际结束分离的测试保留零残留断言，并增加早回执及容量未释放断言。LLM HTTP旅程在close前有限轮询零工作及两条真实网络取消，不以宿主close代替传输排空。

突变装置校准：最初删除冗余取消监听并未破坏可观察行为，不能视为漏检真实缺陷；改为破坏通用cancel发布和progress失败回执，11项均以行为AssertionError检出。导入失败/超时不记作检出。校准不修改门禁、覆盖率或断言。

HTTP排空负控由独立审查者在/tmp隔离副本完成：基线通过；注入未结束任务时poll以AssertionError报告tasks:1；阻断真实上游取消时poll以AssertionError报告cancelled:0。两次均为行为断言拒绝，并非导入失败或运行器超时；未修改工作区。
