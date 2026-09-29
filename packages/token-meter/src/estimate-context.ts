import type { SurfaceNode } from "@x-harness/session";
import { estimateText } from "./plugin.ts";
import { nodeTokens } from "./estimate-nodes.ts";

export const THINKING_COEFF_LEGACY = 0.8;
export const THINKING_COEFF_TEXT = 0.5;
export const WIRE_TOKENS_PER_NODE = 40;

interface ThinkingPayload {
  readonly text: number;
  readonly signature: number;
}

function thinkingPayloadOf(nodes: readonly SurfaceNode[]): ThinkingPayload {
  let text = 0;
  let signature = 0;
  for (const node of nodes) {
    const event = node.event;
    if (event.type !== "assistant/message") continue;
    const thinking = (event.data as { thinking?: unknown }).thinking;
    if (typeof thinking === "string" && thinking !== "") text += estimateText(thinking);
    const blocks = (event.data as { thinkingBlocks?: unknown }).thinkingBlocks;
    if (Array.isArray(blocks)) {
      for (const block of blocks) {
        const sig = (block as { signature?: unknown }).signature;
        if (typeof sig === "string" && sig !== "") signature += estimateText(sig);
      }
    }
  }
  return { text, signature };
}

export interface ContextEstimateOptions {
  readonly legacyCoefficient?: number;
  readonly textCoefficient?: number;
  readonly wireTokensPerNode?: number;
}

export function estimateContextTokens(nodes: readonly SurfaceNode[], options: ContextEstimateOptions = {}): number {
  const legacyCoefficient = options.legacyCoefficient ?? THINKING_COEFF_LEGACY;
  const textCoefficient = options.textCoefficient ?? THINKING_COEFF_TEXT;
  const wireTokensPerNode = options.wireTokensPerNode ?? WIRE_TOKENS_PER_NODE;
  let base = 0;
  for (const node of nodes) base += nodeTokens(node);
  const payload = thinkingPayloadOf(nodes);
  const legacyText = signatureOverlapText(nodes);
  const thinkingTokens = payload.signature > 0
    ? payload.signature + textCoefficient * (payload.text - legacyText) + legacyCoefficient * legacyText
    : legacyCoefficient * payload.text;
  return Math.ceil(base + thinkingTokens + wireTokensPerNode * nodes.length);
}

function signatureOverlapText(nodes: readonly SurfaceNode[]): number {
  let legacyText = 0;
  for (const node of nodes) {
    const event = node.event;
    if (event.type !== "assistant/message") continue;
    const blocks = (event.data as { thinkingBlocks?: unknown }).thinkingBlocks;
    if (Array.isArray(blocks) && blocks.length > 0) continue;
    const thinking = (event.data as { thinking?: unknown }).thinking;
    if (typeof thinking === "string" && thinking !== "") legacyText += estimateText(thinking);
  }
  return legacyText;
}

export function spanContextTokens(spanNodes: readonly SurfaceNode[], options: ContextEstimateOptions = {}): number {
  return estimateContextTokens(spanNodes, options);
}
