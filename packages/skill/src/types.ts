// skill 子系统契约类型（docs/SKILL.md §1.2）。

export interface SkillMeta {
  readonly name: string;
  readonly description: string;
  /** SKILL.md 绝对路径——清单披露给模型的读取入口 */
  readonly path: string;
}

export interface SkillLoadResult {
  readonly skills: Readonly<Record<string, SkillMeta>>;
  /** 拒注册告警（垃圾输入降级——不 throw 不崩） */
  readonly warnings: readonly string[];
}

export interface SkillPluginOptions {
  /** 覆盖目录解析；`[]` = 显式零（不扫描不注入——与 resolveAgentDirs 落空回退语义有意不同） */
  readonly skillsDirs?: readonly string[];
  readonly onWarn?: (message: string) => void;
}
