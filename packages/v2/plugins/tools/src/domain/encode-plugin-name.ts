export function encodePluginName(kind: "tool" | "tool-policy", name: string): string {
  return `${kind}/t-${name.split("").map(character => character.charCodeAt(0).toString(16).padStart(2, "0")).join("")}`;
}
