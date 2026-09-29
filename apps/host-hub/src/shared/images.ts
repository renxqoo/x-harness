import { PROMPT_IMAGES_MAX, PROMPT_IMAGES_TOTAL_MAX, PROMPT_IMAGE_DATA_MAX } from "./limits.ts";

export interface WireImage {
  type: "image";
  data: string;
  mediaType: string;
}

function imageBlockOf(item: unknown): { ok: true; image: WireImage } | { ok: false; code: "invalid_input" | "images_too_many"; reason: string } {
  if (typeof item !== "object" || item === null) return { ok: false, code: "invalid_input", reason: "invalid images: bad block" };
  const block = item as { type?: unknown; data?: unknown; mediaType?: unknown };
  if (block.type !== "image") return { ok: false, code: "invalid_input", reason: "invalid images: type must be image" };
  if (typeof block.data !== "string" || block.data === "") {
    return { ok: false, code: "invalid_input", reason: "invalid images: data must be non-empty base64" };
  }
  if (block.data.length > PROMPT_IMAGE_DATA_MAX) {
    return { ok: false, code: "images_too_many", reason: `invalid images: image too large (max ${PROMPT_IMAGE_DATA_MAX} base64 chars)` };
  }
  if (typeof block.mediaType !== "string" || block.mediaType === "") {
    return { ok: false, code: "invalid_input", reason: "invalid images: mediaType required" };
  }
  return { ok: true, image: { type: "image", data: block.data, mediaType: block.mediaType } };
}

export function normalizeImages(
  value: unknown,
): { ok: true; images: WireImage[] | undefined } | { ok: false; code: "invalid_input" | "images_too_many"; reason: string } {
  if (value === undefined || value === null) return { ok: true, images: undefined };
  if (!Array.isArray(value)) return { ok: false, code: "invalid_input", reason: "invalid images: expected array" };
  if (value.length === 0) return { ok: true, images: undefined };
  if (value.length > PROMPT_IMAGES_MAX) return { ok: false, code: "images_too_many", reason: `invalid images: too many images (max ${PROMPT_IMAGES_MAX})` };
  const images: WireImage[] = [];
  let total = 0;
  for (const item of value) {
    const parsed = imageBlockOf(item);
    if (!parsed.ok) return { ok: false, code: parsed.code, reason: parsed.reason };
    total += parsed.image.data.length;
    if (total > PROMPT_IMAGES_TOTAL_MAX) {
      return { ok: false, code: "images_too_many", reason: `invalid images: images too large in total (max ${PROMPT_IMAGES_TOTAL_MAX} base64 chars)` };
    }
    images.push(parsed.image);
  }
  return { ok: true, images };
}
