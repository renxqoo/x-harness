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
  /** 技能目录（必收——插件不自持缺省/env/路径知识，由宿主边沿用 resolveSkillDirs 统一解析；
   *  `[]` = 显式零：不扫描不注入） */
  readonly skillsDirs: readonly string[];
  /** 禁用名单（合并后按名过滤——清单与快照同滤；同名各层全灭是可解释语义） */
  readonly disabled?: readonly string[];
  readonly onWarn?: (message: string) => void;
}
