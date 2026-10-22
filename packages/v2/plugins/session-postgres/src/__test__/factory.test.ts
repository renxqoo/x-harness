import { expect, it } from "vitest";
import { createPostgresSessionPlugin } from "../index";

it("storage factory rejects invalid backend configuration without opening a resource", () => {
  const bad = [
    null,
    1,
    {},
    { extra: 1 },
    { url: "postgres://localhost", limits: { maxQueue: 0 } },
    { path: "" },
    { path: "a\0b" },
    { path: "x", url: "bad" },
    { url: "https://example.com" },
    { url: "not a url" },
  ];

  for (const input of bad) {
    expect(createPostgresSessionPlugin(input as never)).toMatchObject({
      ok: false,
      error: { code: "invalid-input" },
    });
  }
});
