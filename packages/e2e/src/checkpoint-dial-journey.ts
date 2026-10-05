import { createContext, loadPlugins } from "@x-harness/core";
import { createAnthropicCompatAdapter, llmPlugin, llmRuntime } from "@x-harness/llm";
import type { LlmRequest } from "@x-harness/llm";
import { CP_SYSTEM_PROMPT, CP_UPDATE_PROMPT } from "@x-harness/autocompact";
import { runTextRequest, summarizeFolded } from "@x-harness/compaction";
import type { SummarizerFace } from "@x-harness/compaction";
import type { SurfaceNode } from "@x-harness/session";

const FLASH_MODEL = process.env.GLM_FLASH_MODEL ?? "glm-5.3-flash";

function readCredentials(): { readonly apiKey: string; readonly baseUrl: string; readonly mainModel: string } {
  const apiKey = process.env.GLM_API_KEY ?? "";
  const baseUrl = process.env.GLM_BASE_URL ?? "";
  const mainModel = process.env.GLM_MODEL ?? "";
  if (apiKey === "" || baseUrl === "" || mainModel === "") throw new Error("credentials-absent");
  return { apiKey, baseUrl, mainModel };
}


function summarizerDialOf(mainDial: string, catalogModels: readonly string[]): string {
  const flash = catalogModels.find((m) => m.includes("flash"));
  return flash ?? mainDial;
}

function segmentNodes(count: number): readonly SurfaceNode[] {
  return Array.from({ length: count }, (_, i) => ({
    seq: i,
    event: {
      type: i % 2 === 0 ? "user/message" : "assistant/message",
      seq: i,
      time: i,
      surfaceOp: "append",
      data: {
        turn: Math.floor(i / 4),
        step: i % 4,
        content: [{ type: "text", text: `[turn ${String(Math.floor(i / 4))}] message ${String(i)}: ${"content line with path /a/b/c.ts and findings ".repeat(60)}` }],
      },
    } as never,
  })) as readonly SurfaceNode[];
}

function must(condition: boolean, label: string): void {
  if (!condition) throw new Error(`旅程失败：${label}`);
}

export async function runCheckpointDialJourney(): Promise<void> {
  if (credentialsAbsent()) {
    console.log("skip: checkpoint-dial（env 凭证缺席）");
    return;
  }
  await main();
}

function credentialsAbsent(): boolean {
  return (process.env.GLM_API_KEY ?? "") === "" || (process.env.GLM_BASE_URL ?? "") === "" || (process.env.GLM_MODEL ?? "") === "";
}

async function main(): Promise<void> {
  const { apiKey, baseUrl, mainModel } = readCredentials();
  const dial = summarizerDialOf(mainModel, [mainModel, FLASH_MODEL]);
  console.log(`summarizer dial 解析: ${dial}（主 dial ${mainModel}）`);
  must(dial === FLASH_MODEL, "flash 选中（catalog 同 provider 含 flash）");

  const face: SummarizerFace = { model: dial, provider: "GLM", contextWindow: 1_000_000, maxOutputTokens: 13_107 };
  const ctx = createContext();
  await loadPlugins(ctx, [llmPlugin]);
  const runtime = ctx.use(llmRuntime);
  const rawStream = runtime.stream.bind(runtime);
  const calls: LlmRequest[] = [];
  runtime.registerAdapter(
    createAnthropicCompatAdapter({ name: "GLM", baseUrl, apiKey, contextWindow: 1_000_000 }),
  );
  const recording = {
    ...runtime,
    stream: (request: LlmRequest) => {
      calls.push(request);
      return rawStream(request);
    },
  } as typeof runtime;

  try {
    await checkpointJourney(recording, face);
    await foldedJourney(recording, face, calls);
    await controlJourney(recording, mainModel);
    console.log("checkpoint-dial 旅程全部通过：flash dial 解析 / checkpoint 请求 / 分段摘要 / 主链路对照");
  } finally {
    await ctx.dispose();
  }
}

async function checkpointJourney(llm: typeof llmRuntime extends never ? never : Parameters<typeof runTextRequest>[0]["llm"], face: SummarizerFace): Promise<void> {
  const nodes = segmentNodes(40);
  const segmentText = nodes
    .map((n) => (n.event.data as { content: ReadonlyArray<{ text: string }> }).content[0]?.text ?? "")
    .join("\n\n");
  const ledgerText = "<goals>\n- ship the sdk\n</goals>\n<current>\n- assembling worker bridge\n</current>";
  const prompt = `<ledger>\n${ledgerText}\n</ledger>\n\n<new-segment>\n${segmentText}\n</new-segment>\n\n${CP_UPDATE_PROMPT}`;
  console.log(`旅程1 checkpoint 请求：segment ${String(segmentText.length)} 字符`);
  const t0 = Date.now();
  const outcome = await runTextRequest({ llm, face, system: CP_SYSTEM_PROMPT, prompt, idleTimeoutMs: 120_000, signal: new AbortController().signal });
  const ms = Date.now() - t0;
  console.log(`  ok=${String(outcome.ok)}${outcome.ok ? "" : ` reason=${outcome.reason}`} 耗时 ${String(ms)}ms`);
  must(outcome.ok, `checkpoint 形态请求成功（${outcome.ok ? "" : outcome.reason}）`);
  must(outcome.ok && outcome.text.includes("<goals>"), "checkpoint 输出为七段 ledger 结构");
}

async function foldedJourney(llm: Parameters<typeof runTextRequest>[0]["llm"], face: SummarizerFace, calls: readonly LlmRequest[]): Promise<void> {
  const nodes = segmentNodes(40);
  const before = calls.length;
  console.log("旅程2 分段折叠摘要（40k 窗强制多段）");
  const t0 = Date.now();
  const outcome = await summarizeFolded({
    llm,
    face: { ...face, contextWindow: 40_000, maxOutputTokens: 4_000 },
    reserveTokens: 2_000,
    nodes,
    signal: new AbortController().signal,
  });
  const ms = Date.now() - t0;
  const dials = calls.length - before;
  console.log(`  ok=${String(outcome.ok)}${outcome.ok ? "" : ` reason=${outcome.reason}`} 耗时 ${String(ms)}ms 拨号 ${String(dials)} 次`);
  must(outcome.ok, `分段摘要成功（${outcome.ok ? "" : outcome.reason}）`);
  must(dials > 1, "分段：多段拨号");
  for (const call of calls.slice(before)) {
    const promptChars = call.messages.reduce((sum, m) => sum + JSON.stringify(m).length, 0);
    must(call.model === "glm-5.3-flash", `拨号模型为 flash（实际 ${call.model}）`);
    must(call.thinking === "off", `thinking off（实际 ${String(call.thinking)}）`);
    console.log(`  拨号: maxTokens=${String(call.maxTokens)} promptChars=${String(promptChars)}`);
  }
}

async function controlJourney(llm: Parameters<typeof runTextRequest>[0]["llm"], mainModel: string): Promise<void> {
  console.log("旅程3 主链路对照（同 adapter 主模型）");
  const t0 = Date.now();
  const outcome = await runTextRequest({
    llm,
    face: { model: mainModel, provider: "GLM", contextWindow: 1_000_000, maxOutputTokens: 256 },
    system: "You are a helpful assistant.",
    prompt: "reply with the single word: ok",
    idleTimeoutMs: 30_000,
    signal: new AbortController().signal,
  });
  console.log(`  ok=${String(outcome.ok)} 耗时 ${String(Date.now() - t0)}ms`);
  must(outcome.ok, "主链路对照成功（排除 adapter/网络因素）");
}
