// 线上图片形状校验/归一（DESIGN §3.2）：块形 {type:"image", data:base64, mediaType}；
// 空数组归 undefined（不占载荷）；坏形状整体拒绝（不静默丢块）。量限三条单点执法
// （单图/张数/总量——BATCH2-DESIGN §1.1）。
import { PROMPT_IMAGES_MAX, PROMPT_IMAGES_TOTAL_MAX, PROMPT_IMAGE_DATA_MAX } from "./limits.ts";

export interface WireImage {
  type: "image";
  data: string;
  mediaType: string;
}

/** 单块校验/归一（形状 + 单图量限——复杂度拆分自 normalizeImages）；code = 消费
 *  行为族（形状 → invalid_input / 量限 → images_too_many），发射站点原样透传 */
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
