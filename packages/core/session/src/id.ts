import { isSafeSessionId } from "./gates.ts";
import type { SessionId } from "./types.ts";

const RANDOM_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const RANDOM_LENGTH = 6;

function randomSuffix(random: () => number): string {
  let suffix = "";
  for (let index = 0; index < RANDOM_LENGTH; index += 1) {
    const at = Math.min(Math.floor(random() * RANDOM_ALPHABET.length), RANDOM_ALPHABET.length - 1);
    suffix += RANDOM_ALPHABET[at];
  }
  return suffix;
}

function timestamp(now: Date): string {
  const pad = (value: number, width: number): string => String(value).padStart(width, "0");
  return `${pad(now.getUTCFullYear(), 4)}${pad(now.getUTCMonth() + 1, 2)}${pad(now.getUTCDate(), 2)}T${pad(now.getUTCHours(), 2)}${pad(now.getUTCMinutes(), 2)}${pad(now.getUTCSeconds(), 2)}`;
}

export function mintSessionId(now: Date = new Date(), random: () => number = Math.random): SessionId {
  const id = `${timestamp(now)}-${randomSuffix(random)}`;
  if (!isSafeSessionId(id)) {
    throw new Error(`mintSessionId produced an unsafe id: ${id}`);
  }
  return id as SessionId;
}
