# 独立实现与假绿审查

审查者scheduler_code_review只读，未参与实现；最终问题清单为空。

独立/tmp探针覆盖失败父节点、多个后代、结果预算超额和另一批排队请求交错，180/230/1000字节结果均符合预期，队列未丢失。核对实际退出容量、取消、公平轮转、原始提交者/委托身份、执行前撤权、输入快照、DAG预算及公共tools验证复用。

真实HTTP初始旅程存在断言盲区：a,b,c输入顺序下忽略依赖仍可能因FIFO碰巧通过。隔离副本负控证实原旅程错误放行；改成child在parent前，并记录服务端finish(parent)先于start(child)后，同一突变会明确报HTTP child started before parent completion，外层AssertionError检出。单元DAG负控原本即可检出，集成旅程也必须独立证明这一性质。

GC旅程在宿主保持打开时保存已关闭progress函数，消费回调WeakRef回收，队列/请求计数归零。独立删除tools progress清理的突变使subject:false，并由AssertionError检出，不把装载失败或运行器超时算成功。

更新后的隔离副本完整构建通过，GC+双向源码/产物混装真实HTTP旅程2/2通过；当前工作区调度器和HTTP共9文件79例通过，该次未采覆盖率。parents依赖引用索引和批内同名get快照不改变权限、执行或生命周期语义。

独立嵌套探针：并发1时工具等待同调度器wait会在整体期限超时，内层零执行，调度器与core计数全部归零，随后调用可成功；immediate返回busy，外层可正常处理并成功。不提前释放父名额或突破并发来伪装支持递归。

逐个SHA256核对存量*.test.ts，零修改/零删除；vitest.config与基线完全相同，90/88/95/96阈值与include/exclude未变。新增范围没有skip/only/todo。8个类型负例校验真实API使用诊断，README/POLICY完整正例编译，不把导入失败算拒绝。

测试装置校准：非法图表改为具名{calls}，避免it.each把数组当多参数展开；空请求{}直接验证，避免与默认请求合并后成为合法请求。未删除断言，没有改存量门禁迁就实现。
