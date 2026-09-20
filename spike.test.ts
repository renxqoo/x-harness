import { test, expect } from "vitest";
test("sqlite runtime probe", async () => {
  const mod: Record<string, unknown> = {};
  try { Object.assign(mod, await import("bun:sqlite")); } catch (e) { mod.bunErr = String(e); }
  try { Object.assign(mod, await import("node:sqlite")); } catch (e) { mod.nodeErr = String(e); }
  console.log("RUNTIME:", typeof Bun !== "undefined" ? "bun" : "node", process.version);
  console.log("bun:sqlite:", mod.bunErr ?? "OK", "| node:sqlite:", mod.nodeErr ?? "OK");
  expect(true).toBe(true);
});
