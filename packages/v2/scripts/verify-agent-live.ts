import { verifyJourney } from "./agent-live/verify-journey";

const baseUrl = process.env.LLM_BASE_URL;
const apiKey = process.env.LLM_API_KEY;
const model = process.env.LLM_MODEL;
const reasoningEffort = process.env.LLM_REASONING_EFFORT;

if (!baseUrl || !apiKey || !model)
  throw new Error("Required explicit LLM_BASE_URL, LLM_API_KEY and LLM_MODEL configuration");

process.stdout.write(
  JSON.stringify(
    await verifyJourney({
      baseUrl,
      apiKey,
      model,
      ...(reasoningEffort ? { reasoningEffort } : {}),
      onStep(step) {
        process.stdout.write(JSON.stringify({ type: "step-start", step }) + "\n");
      },
    }),
  ) + "\n",
);
