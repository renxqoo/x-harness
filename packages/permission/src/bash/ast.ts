import { createRequire } from "node:module";
import type { InjectionKind } from "./injection.ts";
import { PIPE_FETCHERS, isInterpreterName } from "./injection.ts";
import { applyCommandPolicy, basenameOf } from "./wrappers.ts";

export interface Redirect {
  readonly face: "input" | "output";
  readonly op: string;
  readonly target: string | undefined;
}

export interface ParsedCommand {
  readonly argv: readonly string[];
  readonly dynamic: boolean;
  readonly injection?: InjectionKind;
  readonly redirects: readonly Redirect[];
  readonly raw: string;
  readonly ask?: string;
  readonly opaque?: string;
  readonly assignmentPrefix?: boolean;
  readonly stdinFed?: boolean;
}

export type BashParse =
  | { readonly ok: true; readonly commands: readonly ParsedCommand[] }
  | { readonly ok: false; readonly kind: "unparseable" }
  | { readonly ok: false; readonly kind: "parser-unavailable" };

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
      loadFailed = true;
      return { ok: false, kind: "parser-unavailable" };
    }
  }
  return parseWith(src, cachedParser.parse);
}

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
    return { ok: false, kind: "unparseable" };
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
  if (cls === undefined) throw unparseableSignal;
  if (cls === "container") {
    walkContainer(node, ctx, out);
    return;
  }
  if (cls === "leaf") {
    out.push(commandOf(node, ctx, out));
    return;
  }
  if (cls === "host") {
    for (const child of node.namedChildren) walkStatement(child, ctx, out);
    return;
  }
  if (node.type === "command_substitution" || node.type === "process_substitution") {
    walkSubstitution(node, ctx, out);
    out.push({ argv: [], dynamic: true, injection: "command-substitution", redirects: [], raw: node.text });
    return;
  }
  if (EXPANSION_WORDS.has(node.type) || (node.type === "word" && /[*?[]/.test(node.text))) {
    out.push({ argv: [], dynamic: true, redirects: [], raw: node.text });
    return;
  }
}

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

function commandOf(node: SyntaxNode, ctx: WalkCtx, out: ParsedCommand[]): ParsedCommand {
  const argv: string[] = [];
  const redirects: Redirect[] = [...ctx.redirects];
  const flags: Flags = { dynamic: ctx.forceDynamic, injection: ctx.forceInjection };
  const hostCtx: HostCtx = { flags, redirects, out };
  let assignmentPrefix = false;
  for (const child of node.children) {
    if (!child.isNamed) continue;
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
  if (last === undefined || last.argv.length === 0 || !isInterpreterName(basenameOf(last.argv[0] ?? ""))) return undefined;
  for (let i = 0; i < lastIdx; i++) {
    const kind = PIPE_FETCHERS.get(basenameOf(inner[i]?.argv[0] ?? ""));
    if (kind !== undefined) return kind;
  }
  return undefined;
}

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
  ctx.redirects.push({ face: "input", op: "<<<", target: undefined });
  for (const child of node.namedChildren) {
    const lit = literalOf(child, ctx.out);
    ctx.flags.dynamic ||= lit.dynamic;
    ctx.flags.injection ??= lit.injection;
  }
}

function fileRedirectOf(node: SyntaxNode, ctx: HostCtx): void {
  const descriptor = node.namedChildren.find((child) => child.type === "file_descriptor");
  const opToken = node.children.find((child) => !child.isNamed)?.type ?? "";
  const op = `${descriptor?.text ?? ""}${opToken}`;
  const dest = node.namedChildren.find((child) => child.type !== "file_descriptor");
  if (dest === undefined || dest.type === "number" || opToken === ">&-" || opToken === "<&-") return;
  if (dest.type === "process_substitution") {
    walkSubstitution(dest, EMPTY_CTX, ctx.out);
    ctx.redirects.push({ face: "input", op, target: undefined });
    return;
  }
  const lit = literalOf(dest, ctx.out);
  if (lit.dynamic) ctx.flags.dynamic = true;
  ctx.redirects.push({ face: op.includes("<") ? "input" : "output", op, target: lit.text });
}

function consumeHeredoc(node: SyntaxNode, ctx: HostCtx): void {
  const start = node.namedChildren.find((child) => child.type === "heredoc_start");
  const quoted = start !== undefined && /['"]/.test(start.text);
  if (!quoted) {
    ctx.flags.dynamic = true;
    if (node.text.includes("$(") || node.text.includes("`")) ctx.flags.injection ??= "command-substitution";
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

function literalOf(node: SyntaxNode, out: ParsedCommand[]): Literal {
  switch (node.type) {
    case "word":
      return { text: unescapeWord(node.text), dynamic: /[*?[]/.test(node.text) };
    case "raw_string":
      return { text: node.text.slice(1, -1), dynamic: false };
    case "string":
    case "translated_string":
      return stringLiteral(node, out);
    case "ansi_c_string":
      return { text: node.text, dynamic: true };
    case "concatenation":
    case "command_name":
      return concatenationLiteral(node, out);
    case "command_substitution":
    case "process_substitution":
      walkSubstitution(node, EMPTY_CTX, out);
      return { text: node.text, dynamic: true, injection: "command-substitution" };
    case "simple_expansion":
    case "expansion":
    case "special_variable_name":
    case "arithmetic_expansion":
    case "extglob_pattern":
      return { text: node.text, dynamic: true };
    default:
      return { text: node.text, dynamic: false };
  }
}

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
