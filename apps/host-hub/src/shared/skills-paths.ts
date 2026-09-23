// 技能目录约定单点：路径常量已上收 @x-harness/skill（loader 的 userSkillsDirOf/
// projectSkillsDirOf——与 resolveSkillDirs 同源）；本模块保留为 host-hub 引用面（管理面
// skills-admin/skills-install 与 worker 装配同源引用，防路径知识回迁宿主散写）。
// homeDir 注入缝语义不变：缺省真实 HOME；测试注入隔离目录（bun 的 os.homedir() 启动即
// 缓存，进程内 HOME 重定向无效——与 agents-admin 同法）。

export { projectSkillsDirOf, userSkillsDirOf } from "@x-harness/skill";
