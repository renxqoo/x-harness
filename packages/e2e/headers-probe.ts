// CDN 差别对待探针：与 http-dial 完全同头，但把 UA 换成 curl 的。
// 用法：GLM_API_KEY=... bun packages/e2e/headers-probe.ts
// 判读：响应头出现 content-encoding → CDN 无视 identity 强压；
//       帧分布平滑 → CDN 按 UA 差别冲刷（Bun UA 被分到大缓冲路径）→ 修复 = http-dial 设 UA。
const url = `${process.env.GLM_BASE_URL ?? "https://open.bigmodel.cn/api/anthropic"}/v1/messages`;
const res = await fetch(url, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-api-key": process.env.GLM_API_KEY ?? "",
    "anthropic-version": "2023-06-01",
    "accept-encoding": "identity",
    "user-agent": "curl/8.7.1",
  },
  body: JSON.stringify({
    model: process.env.GLM_MODEL ?? "glm-4.6",
    max_tokens: 2048,
    stream: true,
    messages: [{ role: "user", content: "写一篇300字短文，介绍长江" }],
  }),
});
console.log(`HTTP ${String(res.status)}`);
for (const [k, v] of res.headers) console.log(`  ${k}: ${v}`);

const t0 = Date.now();
const times: number[] = [];
const reader = (res.body as ReadableStream<Uint8Array>).getReader();
const dec = new TextDecoder();
let buf = "";
let firstBytes = "";
for (;;) {
  const r = await reader.read();
  if (r.done) break;
  if (firstBytes === "") firstBytes = Array.from(r.value.slice(0, 8)).map((b) => b.toString(16).padStart(2, "0")).join(" ");
  buf += dec.decode(r.value, { stream: true });
  while (buf.includes("\n\n")) {
    buf = buf.slice(buf.indexOf("\n\n") + 2);
    times.push(Date.now() - t0);
  }
}
console.log(`响应体首字节：${firstBytes}（gzip 魔数 = 1f 8b 开头）`);
const buckets = new Map<number, number>();
for (const t of times) buckets.set(Math.floor(t / 200), (buckets.get(Math.floor(t / 200)) ?? 0) + 1);
const sorted = [...buckets.entries()].sort((a, b) => a[0] - b[0]);
const maxInBucket = Math.max(...buckets.values());
console.log(`SSE 事件帧 ${String(times.length)} 个 | 200ms 桶最多 ${String(maxInBucket)} 帧 | ${maxInBucket > 60 ? "攒批" : "平滑"}`);
console.log(sorted.map(([b, n]) => `${(b * 200).toString().padStart(5)}ms:${String(n)}`).join("  "));
