export function stderrLine(message: string): void {
  try {
    console.error(message);
  } catch {
  }
}
