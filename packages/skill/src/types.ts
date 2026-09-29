export interface SkillMeta {
  readonly name: string;
  readonly description: string;
  readonly path: string;
}

export interface SkillLoadResult {
  readonly skills: Readonly<Record<string, SkillMeta>>;
  readonly warnings: readonly string[];
}

export interface SkillPluginOptions {
  readonly skillsDirs: readonly string[];
  readonly disabled?: readonly string[];
  readonly onWarn?: (message: string) => void;
}
