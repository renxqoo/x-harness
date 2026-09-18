// bash AST 裁决底座（docs/EXEC-ENV.md §14.2）：tree-sitter-bash 解析 + 分类闭集遍历 →
// ParsedCommand 列表（词面重构 argv / dynamic / injection / 重定向全算符），末段交
// wrappers 层做 argv 政策（包装器/解释器/payload）。ERROR/MISSING、未知 kind、遍历异常
// → unparseable；载体装载失败 → parser-unavailable（上层全量 ask 的 fail-closed 底座）。
// 遍历闭集数据源=语法包 src/node-types.json：named 62 条含 3 条 supertype（_ 前缀，运行期
// 不物化），可见 59 kind 恰归一类——穷尽性测试按同一文件锁定（grammar 升级加 kind 必红）。

import { createRequire } from "node:module";
import type { InjectionKind } from "./injection.ts";
import { PIPE_FETCHERS, PIPE_SHELLS } from "./injection.ts";
import { applyCommandPolicy, basenameOf } from "./wrappers.ts";

export interface Redirect {
  /** 输出面（> >> 2> &> >& >| 及任意 fd 前缀）或输入面（<）——裁决走双面口径（§14.2 边界 2） */
  readonly face: "input" | "output";
  /** 匿名算符子节点原文（> >> 2>> &> >& >| < << <<< 等） */
  readonly op: string;
  /** 目标词面；fd 复制（2>&1 目标是 number）/fd 关闭（>&-）/heredoc（无文件目标）恒 undefined */
  readonly target: string | undefined;
}

export interface ParsedCommand {
  /** 词面重构后的干净 argv（剥引号/转义/拼接）；纯重定向宿主与赋值合成单元为空 */
  readonly argv: readonly string[];
  /** 存在 shell 会展开/通配的词（auto→ask / full→过） */
  readonly dynamic: boolean;
  /** 注入类（命令替换/管道入解释器/空载荷）——压过 full 档与 allow 规则 */
  readonly injection?: InjectionKind;
  readonly redirects: readonly Redirect[];
  readonly raw: string;
  /** 结构失败类恒 ask（剥不动/剥后残渣/载荷传染）——不可被 allow 规则越过（静态裁决失格） */
  readonly ask?: string;
  /** 不透明信任类 ask（source/解释器文件/stdin/字符串实参代码/管道喂入）——可被 allow 规则以用户信任越过 */
  readonly opaque?: string;
  /** 命令带赋值前缀（FOO=x cmd 或 env VAR=x cmd）——解释器家族环境注入链（BASH_ENV）判定用 */
  readonly assignmentPrefix?: boolean;
  /** stdin 由管道/上游填充（pipeline 非首位、xargs/find payload）——裸解释器吃到即执行不可见内容 */
  readonly stdinFed?: boolean;
}

export type BashParse =
  | { readonly ok: true; readonly commands: readonly ParsedCommand[] }
  | { readonly ok: false; readonly kind: "unparseable" }
  | { readonly ok: false; readonly kind: "parser-unavailable" };

/** 语法树节点（tree-sitter 结构形状——按消费面收窄；named 标志的属性名是 isNamed） */
interface SyntaxNode {
  readonly type: string;
  readonly isNamed: boolean;
  readonly text: string;
  readonly hasError: boolean;
  readonly children: readonly SyntaxNode[];
  readonly namedChildren: readonly SyntaxNode[];
}

type ParseFn = (src: string) => { readonly rootNode: SyntaxNode };
type Loaded = { readonly parse: ParseFn };
interface ParserCtor {
  new (): { setLanguage(lang: unknown): void; parse: ParseFn };
}
export type ParserLoader = () => { readonly Parser: ParserCtor; readonly Bash: unknown };

const unparseableSignal = Symbol("bash-unparseable");

/** 分类闭集（§14.2 表——59 可见 kind 恰归一类；数据源 node-types.json，穷尽性测试锁） */
export type NodeClass = "container" | "leaf" | "word" | "host" | "inert";

const CONTAINERS: ReadonlySet<string> = new Set([
  "program", "list", "subshell", "compound_statement", "if_statement", "elif_clause", "else_clause",
  "while_statement", "for_statement", "c_style_for_statement", "case_statement", "case_item", "do_group",
  "function_definition", "pipeline", "negated_command", "redirected_statement", "variable_assignment",
  "variable_assignments", "declaration_command", "array", "heredoc_body", "test_command",
  "binary_expression", "unary_expression", "ternary_expression", "postfix_expression",
  "parenthesized_expression", "brace_expression", "subscript",
]);
const LEAVES: ReadonlySet<string> = new Set(["command", "unset_command"]);
const WORDS: ReadonlySet<string> = new Set([
  "command_name", "word", "string", "string_content", "raw_string", "translated_string", "ansi_c_string",
  "concatenation", "number", "simple_expansion", "expansion", "special_variable_name", "variable_name",
  "arithmetic_expansion", "command_substitution", "process_substitution", "regex", "extglob_pattern",
  "file_descriptor", "test_operator",
]);
const HOSTS: ReadonlySet<string> = new Set(["file_redirect", "heredoc_redirect", "herestring_redirect"]);
const INERT: ReadonlySet<string> = new Set(["comment", "heredoc_start", "heredoc_content", "heredoc_end"]);
const EXPANSION_WORDS: ReadonlySet<string> = new Set([
  "simple_expansion", "expansion", "special_variable_name", "arithmetic_expansion", "extglob_pattern", "ansi_c_string",
]);

/** kind → 类别；闭集外 → undefined（fail-closed：遍历遇未知 kind 抛 unparseable） */
export function classifyKind(kind: string): NodeClass | undefined {
  if (CONTAINERS.has(kind)) return "container";
  if (LEAVES.has(kind)) return "leaf";
  if (WORDS.has(kind)) return "word";
  if (HOSTS.has(kind)) return "host";
  if (INERT.has(kind)) return "inert";
  return undefined;
}

const nodeRequire = createRequire(import.meta.url);

function defaultLoader(): { Parser: ParserCtor; Bash: unknown } {
  const Parser = nodeRequire("tree-sitter") as { default?: ParserCtor } & ParserCtor;
  const Bash = nodeRequire("tree-sitter-bash") as { default?: unknown };
  const ParserCtor = Parser.default ?? Parser;
  if (typeof ParserCtor !== "function") throw new Error("tree-sitter load failed");
  return { Parser: ParserCtor, Bash: Bash.default ?? Bash };
}

let cachedParser: Loaded | undefined;
let loadFailed = false;

export function parseBash(src: string): BashParse {
  if (loadFailed) return { ok: false, kind: "parser-unavailable" };
  if (cachedParser === undefined) {
    try {
      const { Parser, Bash } = defaultLoader();
      const parser = new Parser();
      parser.setLanguage(Bash);
      cachedParser = { parse: (s: string) => parser.parse(s) };
    } catch {
      loadFailed = true; // memoized——装载失败后 bash 全量 ask，不反复重试
      return { ok: false, kind: "parser-unavailable" };
    }
  }
  return parseWith(src, cachedParser.parse);
}

/** 测试接缝：装载失败路径用真接缝背书（注入抛错装载器 → parser-unavailable） */
export function parseBashWith(src: string, load: ParserLoader): BashParse {
  try {
    const { Parser, Bash } = load();
    const parser = new Parser();
    parser.setLanguage(Bash);
    return parseWith(src, (s: string) => parser.parse(s));
  } catch {
    return { ok: false, kind: "parser-unavailable" };
  }
}

function parseWith(src: string, parse: ParseFn): BashParse {
  try {
    const tree = parse(src);
    if (tree.rootNode.hasError) return { ok: false, kind: "unparseable" };
    const commands: ParsedCommand[] = [];
    walkStatement(tree.rootNode, EMPTY_CTX, commands);
    return { ok: true, commands: applyCommandPolicy(commands, (inner: string) => parseWith(inner, parse)) };
  } catch {
    return { ok: false, kind: "unparseable" }; // 遍历异常（未知 kind 哨兵/深嵌套 RangeError）——垃圾输入不崩 pre-execute
  }
}

interface WalkCtx {
  readonly redirects: readonly Redirect[];
  readonly forceDynamic: boolean;
  readonly forceInjection: InjectionKind | undefined;
}

const EMPTY_CTX: WalkCtx = { redirects: [], forceDynamic: false, forceInjection: undefined };

interface Flags {
  dynamic: boolean;
  injection: InjectionKind | undefined;
}

interface Literal {
  readonly text: string;
  readonly dynamic: boolean;
  readonly injection?: InjectionKind;
}

function walkStatement(node: SyntaxNode, ctx: WalkCtx, out: ParsedCommand[]): void {
  const cls = classifyKind(node.type);
  if (cls === undefined) throw unparseableSignal; // 未知 kind → fail-closed
  if (cls === "container") {
    walkContainer(node, ctx, out);
    return;
  }
  if (cls === "leaf") {
    out.push(commandOf(node, ctx, out));
    return;
  }
  if (cls === "host") {
    for (const child of node.namedChildren) walkStatement(child, ctx, out); // 防御位：宿主子件（体展开/procsub）仍收集
    return;
  }
  if (node.type === "command_substitution" || node.type === "process_substitution") {
    walkSubstitution(node, ctx, out); // 替换节点=命令容器（词类身份、容器语义）
    out.push({ argv: [], dynamic: true, injection: "command-substitution", redirects: [], raw: node.text }); // 语句位替换（[[ ]]/case/for 值位）——外层合成单元保注入压制
    return;
  }
  if (EXPANSION_WORDS.has(node.type) || (node.type === "word" && /[*?[]/.test(node.text))) {
    out.push({ argv: [], dynamic: true, redirects: [], raw: node.text }); // 语句位展开（[[ $HOME == x ]] 等）——外层 dynamic
    return;
  }
  // 其余 word / inert 在语句位不产命令（词件由 command 消费；注释/定界词惰性）
}

/** 词位消费的替换递归：只收内层命令，不产语句位合成单元（echo $(x) 的注入标在命令本体） */
function walkSubstitution(node: SyntaxNode, ctx: WalkCtx, out: ParsedCommand[]): void {
  for (const child of node.namedChildren) walkStatement(child, ctx, out);
}

function walkContainer(node: SyntaxNode, ctx: WalkCtx, out: ParsedCommand[]): void {
  if (node.type === "redirected_statement") {
    redirectedOf(node, ctx, out);
    return;
  }
  if (node.type === "variable_assignment" || node.type === "declaration_command") {
    assignmentOf(node, out);
    return;
  }
  if (node.type === "pipeline") {
    pipelineOf(node, ctx, out);
    return;
  }
  for (const child of node.namedChildren) walkStatement(child, ctx, out);
}

interface HostCtx {
  flags: Flags;
  redirects: Redirect[];
  out: ParsedCommand[];
}

/** redirected_statement：重定向归属 body 的每个叶命令；无 body（`> /etc/passwd`）→ argv=[] 纯重定向宿主 */
function redirectedOf(node: SyntaxNode, ctx: WalkCtx, out: ParsedCommand[]): void {
  const redirects: Redirect[] = [...ctx.redirects];
  const flags: Flags = { dynamic: ctx.forceDynamic, injection: ctx.forceInjection };
  const hostCtx: HostCtx = { flags, redirects, out };
  let body: SyntaxNode | undefined;
  for (const child of node.namedChildren) {
    if (classifyKind(child.type) === "host") {
      consumeHost(child, hostCtx);
      continue;
    }
    body ??= child;
  }
  if (body === undefined) {
    if (redirects.length > 0) {
      out.push({ argv: [], dynamic: flags.dynamic, injection: flags.injection, redirects, raw: node.text });
    }
    return;
  }
  walkStatement(body, { redirects, forceDynamic: flags.dynamic, forceInjection: flags.injection }, out);
}

/** command 叶：词面子件入 argv（command_name 同为词件）；赋值前缀跳过 argv 但吃 $( ) 展开；
 *  容器子件（time (…) 的 subshell）递归收集；宿主子件入 redirects。 */
function commandOf(node: SyntaxNode, ctx: WalkCtx, out: ParsedCommand[]): ParsedCommand {
  const argv: string[] = [];
  const redirects: Redirect[] = [...ctx.redirects];
  const flags: Flags = { dynamic: ctx.forceDynamic, injection: ctx.forceInjection };
  const hostCtx: HostCtx = { flags, redirects, out };
  let assignmentPrefix = false;
  for (const child of node.children) {
    if (!child.isNamed) continue; // 匿名子件是分隔/括号 token——词面与结构都不参与
    if (child.type === "variable_assignment") {
      assignmentPrefix = true;
      if (scanExpansions(child, out).cmdsub) flags.injection ??= "command-substitution";
      continue;
    }
    const cls = classifyKind(child.type);
    if (cls === undefined) throw unparseableSignal;
    if (cls === "word") {
      const lit = literalOf(child, out);
      if (lit.text !== "") argv.push(lit.text);
      flags.dynamic ||= lit.dynamic;
      flags.injection ??= lit.injection;
      continue;
    }
    if (cls === "host") {
      consumeHost(child, hostCtx);
      continue;
    }
    if (cls === "container") walkStatement(child, EMPTY_CTX, out);
  }
  return {
    argv,
    dynamic: flags.dynamic,
    injection: flags.injection,
    redirects,
    raw: node.text,
    ...(assignmentPrefix ? { assignmentPrefix: true } : {}),
  };
}

/** 语句位赋值/declaration：含展开才产合成单元（FOO=bar 纯字面不产——空转无执法面）；
 *  declaration 引号实参原文兜底扫描（declare -a 'a=($(cmd))' 引号内 bash 真执行而 AST 无节点）。 */
function assignmentOf(node: SyntaxNode, out: ParsedCommand[]): void {
  const flags: Flags = { dynamic: false, injection: undefined };
  const declaration = node.type === "declaration_command";
  for (const child of node.namedChildren) {
    if (child.type === "variable_assignment") foldAssignmentValue(child, flags, out);
    else foldDeclarationArg({ child, flags, out, declaration });
  }
  if (!flags.dynamic && flags.injection === undefined) return;
  out.push({ argv: [], dynamic: flags.dynamic, injection: flags.injection, redirects: [], raw: node.text });
}

function foldAssignmentValue(child: SyntaxNode, flags: Flags, out: ParsedCommand[]): void {
  const scan = scanExpansions(child, out);
  if (scan.cmdsub) flags.injection ??= "command-substitution";
  if (scan.expansion) flags.dynamic = true;
}

interface ArgFoldCtx {
  readonly child: SyntaxNode;
  readonly flags: Flags;
  readonly out: ParsedCommand[];
  readonly declaration: boolean;
}

function foldDeclarationArg(ctx: ArgFoldCtx): void {
  const { child, flags, out, declaration } = ctx;
  const lit = literalOf(child, out);
  flags.dynamic ||= lit.dynamic;
  flags.injection ??= lit.injection;
  const quoted = child.type === "raw_string" || child.type === "string";
  const commandSubInText = child.text.includes("$(") || child.text.includes("`");
  if (declaration && quoted && commandSubInText) flags.injection ??= "command-substitution";
}

/** pipeline：逐命令收集；末位 shell + 上游 fetcher/base64 → 末位命令标注入（basename 归一）；
 *  非首位命令标 stdinFed——裸解释器吃到管道内容即执行不可见代码（解释器 stdin 规则在 wrappers
 *  剥离后判定，覆盖 timeout 5 sh 等包装形）。 */
function pipelineOf(node: SyntaxNode, ctx: WalkCtx, out: ParsedCommand[]): void {
  const inner: ParsedCommand[] = [];
  for (const child of node.namedChildren) walkStatement(child, ctx, inner);
  let lastIdx = -1;
  for (let i = inner.length - 1; i >= 0; i--) {
    if ((inner[i]?.argv.length ?? 0) > 0) {
      lastIdx = i;
      break;
    }
  }
  if (lastIdx < 0) {
    out.push(...inner);
    return;
  }
  const kind = pipelineKind(inner, lastIdx);
  const last = inner[lastIdx];
  if (kind !== undefined && last !== undefined) inner[lastIdx] = { ...last, injection: kind };
  for (let i = 1; i < inner.length; i++) {
    const cmd = inner[i];
    if (cmd !== undefined && cmd.stdinFed !== true) inner[i] = { ...cmd, stdinFed: true };
  }
  out.push(...inner);
}

function pipelineKind(inner: readonly ParsedCommand[], lastIdx: number): InjectionKind | undefined {
  const last = inner[lastIdx];
  if (last === undefined || last.argv.length === 0 || !PIPE_SHELLS.has(basenameOf(last.argv[0] ?? ""))) return undefined;
  for (let i = 0; i < lastIdx; i++) {
    const kind = PIPE_FETCHERS.get(basenameOf(inner[i]?.argv[0] ?? ""));
    if (kind !== undefined) return kind;
  }
  return undefined;
}

/** 宿主消费：file_redirect（算符=匿名子节点 type——实测 token 文本即 type）；heredoc（引号定界
 *  判定 + 体展开递归）；herestring（词件展开并入命令标记）。 */
function consumeHost(node: SyntaxNode, ctx: HostCtx): void {
  if (node.type === "heredoc_redirect") {
    consumeHeredoc(node, ctx);
    return;
  }
  if (node.type === "herestring_redirect") {
    herestringOf(node, ctx);
    return;
  }
  fileRedirectOf(node, ctx);
}

function herestringOf(node: SyntaxNode, ctx: HostCtx): void {
  ctx.redirects.push({ face: "input", op: "<<<", target: undefined }); // 解释器 stdin 判定面（bash <<< 'sudo id'）
  for (const child of node.namedChildren) {
    const lit = literalOf(child, ctx.out);
    ctx.flags.dynamic ||= lit.dynamic;
    ctx.flags.injection ??= lit.injection;
  }
}

function fileRedirectOf(node: SyntaxNode, ctx: HostCtx): void {
  const descriptor = node.namedChildren.find((child) => child.type === "file_descriptor");
  const opToken = node.children.find((child) => !child.isNamed)?.type ?? "";
  const op = `${descriptor?.text ?? ""}${opToken}`; // 2> 是 descriptor(2)+算符(>) 两节点——组合成完整算符
  const dest = node.namedChildren.find((child) => child.type !== "file_descriptor");
  if (dest === undefined || dest.type === "number" || opToken === ">&-" || opToken === "<&-") return; // fd 复制/关闭无目标
  if (dest.type === "process_substitution") {
    walkSubstitution(dest, EMPTY_CTX, ctx.out); // > >(cmd)：递归收集内层命令（词位——无合成单元）
    ctx.redirects.push({ face: "input", op, target: undefined }); // < <(cmd) 喂 stdin——解释器判定面
    return;
  }
  const lit = literalOf(dest, ctx.out);
  if (lit.dynamic) ctx.flags.dynamic = true; // 目标位展开（cmd > $F / $'…'）——路径不可预测，命令落 dynamic
  ctx.redirects.push({ face: op.includes("<") ? "input" : "output", op, target: lit.text });
}

/** heredoc：非引号定界 → 整语句 dynamic（体会展开）；记一条无目标输入面重定向（解释器
 *  stdin 判定用）；体内 $( ) 递归 + 注入（压过 full）。<<- tab 形 AST 体节点为空（实测盲区）
 *  ——注入证据改由节点全文兜底扫描补（B-P0-2 同法）。 */
function consumeHeredoc(node: SyntaxNode, ctx: HostCtx): void {
  const start = node.namedChildren.find((child) => child.type === "heredoc_start");
  const quoted = start !== undefined && /['"]/.test(start.text);
  if (!quoted) {
    ctx.flags.dynamic = true;
    if (node.text.includes("$(") || node.text.includes("`")) ctx.flags.injection ??= "command-substitution"; // 盲区兜底
  }
  ctx.redirects.push({ face: "input", op: "heredoc", target: undefined });
  const body = node.namedChildren.find((child) => child.type === "heredoc_body");
  if (body !== undefined) {
    for (const child of body.namedChildren) {
      if (child.type === "command_substitution") {
        ctx.flags.injection ??= "command-substitution";
        walkSubstitution(child, EMPTY_CTX, ctx.out);
      }
    }
  }
}

/** 词面重构：剥引号/转义/拼接（sud''o → sudo、s\udo → sudo）；dynamic 只由展开节点类别与
 *  word 原文通配扫描判定（重构后不重扫 $——echo \$HOME 字面形不误标）。 */
function literalOf(node: SyntaxNode, out: ParsedCommand[]): Literal {
  switch (node.type) {
    case "word":
      return { text: unescapeWord(node.text), dynamic: /[*?[]/.test(node.text) };
    case "raw_string":
      return { text: node.text.slice(1, -1), dynamic: false }; // 单引号=真字面量（shell 不展开）
    case "string":
    case "translated_string":
      return stringLiteral(node, out);
    case "ansi_c_string":
      return { text: node.text, dynamic: true }; // bash 解码 $'\x73udo' 执行——不解码、保守（边界 6）
    case "concatenation":
    case "command_name":
      return concatenationLiteral(node, out);
    case "command_substitution":
    case "process_substitution":
      walkSubstitution(node, EMPTY_CTX, out); // 内层命令递归入裁决列表（词位——无语句位合成单元）
      return { text: node.text, dynamic: true, injection: "command-substitution" };
    case "simple_expansion":
    case "expansion":
    case "special_variable_name":
    case "arithmetic_expansion":
    case "extglob_pattern":
      return { text: node.text, dynamic: true };
    default:
      return { text: node.text, dynamic: false }; // number/variable_name/regex/file_descriptor/test_operator/command_name 外壳
  }
}

/** 双引号串：string_content 字面段与展开子件按原文顺序折叠（展开标 dynamic、$( ) 标注入并递归）；
 *  匿名子件是引号 token——跳过（词面=去引号内容） */
function stringLiteral(node: SyntaxNode, out: ParsedCommand[]): Literal {
  let text = "";
  let dynamic = false;
  let injection: InjectionKind | undefined;
  for (const child of node.children) {
    if (!child.isNamed) continue;
    if (child.type === "string_content") {
      text += child.text;
      continue;
    }
    const lit = literalOf(child, out);
    text += lit.text;
    dynamic ||= lit.dynamic;
    injection ??= lit.injection;
  }
  return injection === undefined ? { text, dynamic } : { text, dynamic, injection };
}

function concatenationLiteral(node: SyntaxNode, out: ParsedCommand[]): Literal {
  let text = "";
  let dynamic = false;
  let injection: InjectionKind | undefined;
  for (const child of node.children) {
    if (!child.isNamed) continue;
    const lit = literalOf(child, out);
    text += lit.text;
    dynamic ||= lit.dynamic;
    injection ??= lit.injection;
  }
  return injection === undefined ? { text, dynamic } : { text, dynamic, injection };
}

/** 子树展开扫描（赋值前缀/declaration 值）：$( )/<( ) 递归收集；纯展开只报 expansion——
 *  赋值前缀不拖 dynamic（§14.4 放宽 P1-5），语句位合成单元才消费 expansion。 */
function scanExpansions(node: SyntaxNode, out: ParsedCommand[]): { cmdsub: boolean; expansion: boolean } {
  let cmdsub = false;
  let expansion = false;
  for (const child of node.namedChildren) {
    if (child.type === "command_substitution" || child.type === "process_substitution") {
      cmdsub = true;
      walkSubstitution(child, EMPTY_CTX, out);
      continue;
    }
    if (EXPANSION_WORDS.has(child.type)) {
      expansion = true;
      continue;
    }
    if (child.type === "word") {
      expansion ||= /[*?[]/.test(child.text);
      continue;
    }
    if (child.type === "string" || child.type === "translated_string" || child.type === "concatenation") {
      const lit = literalOf(child, out);
      expansion ||= lit.dynamic;
      cmdsub ||= lit.injection !== undefined;
      continue;
    }
    const scan = scanExpansions(child, out);
    cmdsub ||= scan.cmdsub;
    expansion ||= scan.expansion;
  }
  return { cmdsub, expansion };
}

function unescapeWord(text: string): string {
  return text.replace(/\\(.)/g, "$1");
}
