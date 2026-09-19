// 摘要注入段工具（docs/COMPACTION.md §15.1）：锚点包裹 + 确定性剥离。
// 注入段恒为落账文本最末段；剥离从尾取最后一个完整 begin..end 段——无锚点 no-op
// （L2 账本/旧摘要）、半锚点或尾随内容保守跳过（宁漏剥不误截正文与权威账本标签）。

export const SECTION_BEGIN = "<!-- summary-section:begin -->";
export const SECTION_END = "<!-- summary-section:end -->";

/** 段内锚点字面防御：subject 等模型可写文本可内嵌锚点字面伪造半段（收口审查实证——
 * 伪造 BEGIN 致剥离后正文误截残留、伪造 END 致整段永不剥）。铸造时全角化 HTML 注释
 * 边界（serialize 中和纪律同构）——段内任何锚点字面不再匹配真锚点，剥离恒命中真段。 */
function neutralizeSectionAnchors(section: string): string {
  return section.replaceAll("<!--", "＜!--").replaceAll("-->", "--＞");
}

/** 落账文本组装：段以锚点包裹缀于最末（provider 不感知锚点——包裹由本层统一） */
export function appendSummarySection(summary: string, section: string): string {
  return `${summary}\n\n${SECTION_BEGIN}\n${neutralizeSectionAnchors(section)}\n${SECTION_END}`;
}

/** 剥离摘要文本尾部的注入段：无锚点原样返回（可能为空串——空串 ≠ 无上份，调用方勿混淆） */
export function stripSummarySection(text: string): string {
  const begin = text.lastIndexOf(SECTION_BEGIN);
  if (begin < 0) return text;
  const end = text.indexOf(SECTION_END, begin);
  if (end < 0) return text; // 半锚点：保守跳过
  if (text.slice(end + SECTION_END.length).trim() !== "") return text; // end 后有尾随内容：非最末段，跳过
  return text.slice(0, begin).replace(/\n+$/, "");
}
