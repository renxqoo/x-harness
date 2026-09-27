// stderr host（测试装置）：启动即向 stderr 写标记（stderr 泵验证）
process.stderr.write("STDERR-MARKER hello\n");
setInterval(() => {
  process.stdout.write(`${JSON.stringify({ type: "heartbeat", rssBytes: 1, cpuPercent: 0 })}\n`);
}, 1000);
