// 技能目录约定单点（DESIGN §3.9）：用户根 `~/.x-harness/skills`、项目根
// `<cwd>/.x-harness/skills`——管理面（skills-admin/skills-install）与 worker 装配
// （worker/assembly）同源，防「三处各写一次路径」漂移。
// homeDir 注入缝：缺省真实 HOME；测试注入隔离目录（bun 的 os.homedir() 启动即缓存，
// 进程内 HOME 重定向无效——与 agents-admin 同法）。

import { homedir } from "node:os";
import { join } from "node:path";

export function userSkillsDirOf(homeDir: string = homedir()): string {
  return join(homeDir, ".x-harness", "skills");
}

export function projectSkillsDirOf(cwd: string): string {
  return join(cwd, ".x-harness", "skills");
}
