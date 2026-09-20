// 线上图片形状校验/归一（DESIGN §3.2）：块形 {type:"image", data:base64, mediaType}；
// 空数组归 undefined（不占载荷）；坏形状整体拒绝（不静默丢块）。内核 ContentBlock
// 暂无 image 类型——非 undefined 结果由命令层统一拒 `invalid images: unsupported by
// this kernel`（显式拒绝不静默丢弃，DESIGN MIGRATION §6 挂账）。
export interface WireImage {
  type: "image";
  data: string;
  mediaType: string;
}

export function normalizeImages(
  value: unknown,
): { ok: true; images: WireImage[] | undefined } | { ok: false; reason: string } {
  if (value === undefined || value === null) return { ok: true, images: undefined };
  if (!Array.isArray(value)) return { ok: false, reason: "invalid images: expected array" };
  if (value.length === 0) return { ok: true, images: undefined };
  const images: WireImage[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null) return { ok: false, reason: "invalid images: bad block" };
    const block = item as { type?: unknown; data?: unknown; mediaType?: unknown };
    if (block.type !== "image") return { ok: false, reason: "invalid images: type must be image" };
    if (typeof block.data !== "string" || block.data === "") {
      return { ok: false, reason: "invalid images: data must be non-empty base64" };
    }
    if (typeof block.mediaType !== "string" || block.mediaType === "") {
      return { ok: false, reason: "invalid images: mediaType required" };
    }
    images.push({ type: "image", data: block.data, mediaType: block.mediaType });
  }
  return { ok: true, images };
}
