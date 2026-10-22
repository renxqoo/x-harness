import type { Node, Runtime } from "./types";

export function releaseNode(runtime: Runtime, node: Node) {
  if (node.released) return;

  node.released = true;
  runtime.outstanding--;
}
