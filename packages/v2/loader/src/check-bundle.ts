import { parse } from "acorn";
import { isNativeModule } from "./is-native-module";

type Node = Record<string, unknown> & {
  type?: string;
  source?: { value?: unknown };
  callee?: { name?: string; property?: { name?: string } };
  arguments?: { type?: string; value?: unknown }[];
  meta?: { name?: string };
  property?: { name?: string; value?: unknown };
};

export function checkBundle(source: string, allowed: ReadonlySet<string>): boolean {
  try {
    const tree = parse(source, {
      ecmaVersion: "latest",
      sourceType: "module",
      allowHashBang: true,
    });
    const stack: { value: unknown; parent?: Node }[] = [{ value: tree }];

    while (stack.length) {
      const frame = stack.pop()!;
      const item = frame.value;

      if (!item || typeof item !== "object") continue;

      if (Array.isArray(item)) {
        for (const child of item) stack.push({ value: child, parent: frame.parent });

        continue;
      }

      const node = item as Node;

      if (node.type === "ImportExpression") return false;

      if (node.type === "MetaProperty" && node.meta?.name === "import") {
        const parent = frame.parent;

        if (
          parent?.type !== "MemberExpression" ||
          parent.object !== node ||
          !(parent.computed
            ? ["url", "main"].includes(String(parent.property?.value))
            : ["url", "main"].includes(parent.property?.name ?? ""))
        )
          return false;
      }

      if (
        node.type === "CallExpression" &&
        (node.callee?.name === "require" ||
          /^__require\d*$/.test(node.callee?.name ?? "") ||
          node.callee?.property?.name === "require")
      ) {
        const argument = node.arguments?.[0];

        if (
          node.arguments?.length !== 1 ||
          argument?.type !== "Literal" ||
          typeof argument.value !== "string" ||
          (!allowed.has(argument.value) && !isNativeModule(argument.value))
        )
          return false;
      }

      if (
        ["ImportDeclaration", "ExportNamedDeclaration", "ExportAllDeclaration"].includes(
          node.type ?? "",
        ) &&
        node.source &&
        (typeof node.source.value !== "string" ||
          (!allowed.has(node.source.value) && !isNativeModule(node.source.value)))
      )
        return false;

      for (const child of Object.values(item)) stack.push({ value: child, parent: node });
    }

    return true;
  } catch {
    return false;
  }
}
