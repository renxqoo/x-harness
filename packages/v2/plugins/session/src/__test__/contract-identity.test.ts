import { expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { createSessionPlugin, session } from "../index";
import { session as contract } from "../contracts";
import { createHost } from "../../../../core/src/index";
import { value } from "./helpers";

it("source and build share the canonical session token and can be assembled together", async () => {
  const built = await import(fileURLToPath(new URL("../../dist/index.js", import.meta.url)));
  expect(built.session).toBe(contract); expect(session).toBe(contract);
  const provider = await import(fileURLToPath(new URL("../../../session-sqlite/dist/index.js", import.meta.url)));
  const host = value(createHost());
  try { value(await host.install([value(provider.createSqliteSessionPlugin({ path: ":memory:" })), value(built.createSessionPlugin())])); const service = value(host.use(session)); value(await service.create({ id: "one" })); expect(value(await service.get({ id: "one" })).id).toBe("one"); }
  finally { value(await host.close()); }
  expect(createSessionPlugin).toBeTypeOf("function");
});
