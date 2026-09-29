export function must(condition: boolean, message: string): void {
  if (!condition) throw new Error(`e2e 断言失败: ${message}`);
}
