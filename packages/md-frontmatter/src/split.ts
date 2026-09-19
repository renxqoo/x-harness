// markdown frontmatter 头体切分：文本须以 `---\n` 开头并以首个 `\n---\n` 闭合；
// 不满足该形状返回 undefined（调用方按无 frontmatter 降级）。

export interface FrontmatterParts {
  readonly head: string;
  readonly body: string;
}

export function splitFrontmatter(text: string): FrontmatterParts | undefined {
  if (!text.startsWith("---\n")) return undefined;
  const end = text.indexOf("\n---\n", 4);
  if (end < 0) return undefined;
  return { head: text.slice(4, end), body: text.slice(end + 5) };
}
