process.stderr.write("STDERR-MARKER hello\n");
setInterval(() => {
  process.stdout.write(`${JSON.stringify({ type: "heartbeat", rssBytes: 1, cpuPercent: 0 })}\n`);
}, 1000);
