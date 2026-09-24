// 错误族分类（docs/WORK-ERROR-RECOVERY.md C5 计数器语义）：四桶 + unknown——
// 键 = 族而非裸 code（裸 code 分桶则 429/network 交替永不达阈值，A 审查实锤）。
// 分类纯函数、可覆写（recoverableFamilies 配置面——RETRY_POLICY retryableCodes 同款，
// 宿主可纳 auth 过期等）。

/** 错误族闭集：transport-retryable（网络/HTTP 瞬态）/ http-4xx（语义类——模型可应对）/
 *  auth（鉴权死错）/ context-overflow（窗口溢出死错）；不识 → unknown（按可恢复应对） */
export type ErrorFamily = "transport-retryable" | "http-4xx" | "auth" | "context-overflow" | "unknown";

/** 网络与 HTTP 瞬态状态码（与 llm-retry DEFAULT_RETRYABLE_CODES 同源词表——本包不 import
 *  llm-retry（策略包间不互依），漂移由两侧测试共同钉死） */
const TRANSPORT_CODES: ReadonlySet<string> = new Set(["network", "http-408", "http-429", "http-500", "http-502", "http-503", "http-504"]);
const AUTH_CODES: ReadonlySet<string> = new Set(["http-401", "http-403"]);

export function classifyFailure(code: string | undefined): ErrorFamily {
  if (code !== undefined && TRANSPORT_CODES.has(code)) return "transport-retryable";
  if (code !== undefined && AUTH_CODES.has(code)) return "auth";
  if (code === "context-overflow") return "context-overflow";
  if (code !== undefined && code.startsWith("http-4")) return "http-4xx";
  return "unknown";
}

/** 族处置面：respond（错误回模型自愈）/ fail（死类直收）/ skip（5xx 网络类不 respond
 *  直接 fail——B P2 成本裁决：llm-retry 已试 ×3，再 respond 只烧 token） */
export type FamilyAction = "respond" | "fail" | "skip";

/** 缺省族处置表（recoverableFamilies 覆写面）：skip 与 fail 终态同为收轮（fail 决策），
 *  区别只在语义标签——skip 族不进 respond 计数面（已由 L1 退避耗尽背书）。 */
export const DEFAULT_FAMILY_ACTIONS: Readonly<Record<ErrorFamily, FamilyAction>> = {
  "transport-retryable": "skip",
  "http-4xx": "respond",
  auth: "fail",
  "context-overflow": "fail",
  unknown: "respond",
};
