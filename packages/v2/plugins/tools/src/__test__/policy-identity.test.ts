import { expect, it } from "vitest";
import { createToolPlugin, createToolPolicyPlugin } from "../index";
import { emptySchema, request, text, value, world } from "./helpers";

it.each(["ReadOnly", "read_only", "_policy", "a".repeat(64)])(
  "accepted policy name %s must produce an installable plugin",
  async (name) => {
    const policy = value(
      createToolPolicyPlugin({ name, authorize: () => ({ ok: true, value: { kind: "allow" } }) }),
    );
    const tool = value(
      createToolPlugin({ name: "echo", inputSchema: emptySchema, execute: () => text("done") }),
    );
    const { host, service } = await world([policy, tool]);

    try {
      expect(await service.execute(request())).toEqual(text("done"));
    } finally {
      value(await host.close());
    }
  },
);

it("case and punctuation in policy names must not collapse plugin identities", async () => {
  const names = ["ReadOnly", "readonly", "read_only", "read-only", "_policy"];
  const policies = names.map((name) =>
    value(
      createToolPolicyPlugin({ name, authorize: () => ({ ok: true, value: { kind: "allow" } }) }),
    ),
  );
  expect(new Set(policies.map((policy) => policy.name)).size).toBe(names.length);
  const tool = value(
    createToolPlugin({ name: "echo", inputSchema: emptySchema, execute: () => text("done") }),
  );
  const { host, service } = await world([...policies, tool]);

  try {
    expect(await service.execute(request())).toEqual(text("done"));
  } finally {
    value(await host.close());
  }
});
