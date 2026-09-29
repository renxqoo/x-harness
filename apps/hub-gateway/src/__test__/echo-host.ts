process.stdin.setEncoding("utf8");
let buffer = "";
process.stdin.on("data", (chunk: string) => {
  buffer += chunk;
  for (;;) {
    const nl = buffer.indexOf("\n");
    if (nl < 0) break;
    const line = buffer.slice(0, nl);
    buffer = buffer.slice(nl + 1);
    if (line.length === 0) continue;
    if (process.env["ECHO_HOST_SILENT"] === "1") continue;
    try {
      const parsed = JSON.parse(line) as { id?: string };
      process.stdout.write(`${JSON.stringify({ type: "response", id: parsed.id, command: "echo", success: true, data: { echoed: true } })}\n`);
      process.stdout.write(`${JSON.stringify({ type: "heartbeat", rssBytes: 1, cpuPercent: 0 })}\n`);
    } catch {
    }
  }
});
