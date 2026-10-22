import { isStorageIdentifier } from "../../session/src/storage";
import { stop } from "./fail";
const alphabet = "0123456789abcdefghijklmnopqrstuv";

export function encodeId(id: string): string {
  let bits = 0;
  let value = 0;
  let output = "";

  for (const byte of Buffer.from(id)) {
    value = (value << 8) | byte;
    bits += 8;

    while (bits >= 5) {
      bits -= 5;
      output += alphabet[(value >> bits) & 31];
    }

    value &= (1 << bits) - 1;
  }

  if (bits) output += alphabet[(value << (5 - bits)) & 31];

  return output;
}

export function decodeId(encoded: string): string {
  if (!/^[0-9a-v]{2,205}$/.test(encoded)) stop("storage-corrupt");

  let value = 0;
  let bits = 0;
  const bytes: number[] = [];

  for (const char of encoded) {
    value = (value << 5) | alphabet.indexOf(char);
    bits += 5;

    if (bits >= 8) {
      bits -= 8;
      bytes.push(value >> bits);
      value &= (1 << bits) - 1;
    }
  }

  const id = Buffer.from(bytes).toString("utf8");

  if (!isStorageIdentifier(id) || encodeId(id) !== encoded) stop("storage-corrupt");

  return id;
}
