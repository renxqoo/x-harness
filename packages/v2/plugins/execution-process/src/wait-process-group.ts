export async function waitProcessGroup(pid: number) {
  for (;;) {
    try {
      process.kill(-pid, 0);
    } catch {
      return;
    }

    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}
