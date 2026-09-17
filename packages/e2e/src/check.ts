// 断言糖：失败抛带上下文的错误（main 捕获后置非零退出码）。
export function must(condition: boolean, message: string): void {
  if (!condition) throw new Error(`e2e 断言失败: ${message}`);
}
