if (process.argv.includes("--fake-host")) {
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
      try {
        const cmd = JSON.parse(line) as { id?: string; type?: string };
        if (cmd.type === "thread/start") {
          process.stdout.write(`${JSON.stringify({ type: "response", id: cmd.id, command: "thread/start", success: true, data: { threadId: "t_fake_1", cwd: "/tmp", sessionPath: "/tmp/s.jsonl" } })}\n`);
          process.stdout.write(`${JSON.stringify({ type: "event", threadId: "t_fake_1", name: "turn/start", payload: { session: "t_fake_1", seq: 1 } })}\n`);
        } else {
          process.stdout.write(`${JSON.stringify({ type: "response", id: cmd.id, command: cmd.type, success: true, data: { echoed: true } })}\n`);
        }
      } catch {
      }
    }
  });
  setInterval(() => {
    process.stdout.write(`${JSON.stringify({ type: "heartbeat", rssBytes: 1, cpuPercent: 0 })}\n`);
  }, 1000);
}
