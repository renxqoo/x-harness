import { Database } from "bun:sqlite";
import { expect, it } from "vitest";
import { createHost, definePlugin, defineService } from "../../core/src/index";
import type { Result } from "../../core/src/index";

type User = { id: string; name: string };
type Users = { find(input: { id: string }): Promise<Result<User | null>> };
type Http = { address(input: void): Promise<Result<string>> };

it("a non AI server composes database, users and HTTP plugins and releases them before replacement", async () => {
  const created = createHost();
  const stored = defineService<Users>({ name: "server/storage", methods: { find: {} } });
  const queried = defineService<Users>({ name: "server/users", methods: { find: {} } });
  const serving = defineService<Http>({ name: "server/http", methods: { address: {} } });
  if (!created.ok || !stored.ok || !queried.ok || !serving.ok) throw new Error("fixture definitions failed");
  const app = created.value;
  const storage = stored.value;
  const users = queried.value;
  const http = serving.value;
  const closed: string[] = [];
  let opened = 0;
  const plugins = [
    definePlugin({ name: "database", provides: { storage }, async setup(ctx) {
      const acquired = await ctx.resource({
        open() {
          const database = new Database(":memory:");
          database.run("CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT NOT NULL)");
          database.run("INSERT INTO users VALUES (?, ?)", ["42", "小明"]);
          opened += 1;
          return { ok: true, value: database };
        },
        close(database) { database.close(); closed.push("database"); return { ok: true, value: undefined }; },
      });
      if (!acquired.ok) return acquired;
      const database = acquired.value;
      return ctx.service({ storage: { async find(input) {
        const user = database.query<User, [string]>("SELECT id, name FROM users WHERE id = ?").get(input.id);
        return { ok: true, value: user };
      } } });
    } }),
    definePlugin({ name: "users", requires: { storage }, provides: { users }, setup(ctx) {
      return ctx.service({ users: { async find(input, call) { return call.deps.storage.find(input); } } });
    } }),
    definePlugin({ name: "http", requires: { users }, provides: { http }, async setup(ctx) {
      const scope = ctx.createScope({ label: "requests" });
      if (!scope.ok) return scope;
      const acquired = await ctx.resource({
        open() {
          return { ok: true, value: Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
            const id = new URL(request.url).pathname.slice(1);
            const service = scope.value.use(users);
            if (!service.ok) return Response.json({ error: service.error }, { status: 503 });
            const result = await service.value.find({ id });
            if (!result.ok) return Response.json({ error: result.error }, { status: 503 });
            return Response.json(result.value, { status: result.value ? 200 : 404 });
          } }) };
        },
        async close(server) { await server.stop(true); closed.push("http"); return { ok: true, value: undefined }; },
      });
      if (!acquired.ok) return acquired;
      const address = acquired.value.url.toString();
      return ctx.service({ http: { async address() { return { ok: true, value: address }; } } });
    } }),
  ];
  try {
    for (let round = 0; round < 2; round += 1) {
      const loaded = await app.install(plugins);
      if (!loaded.ok) throw new Error(JSON.stringify(loaded.error));
      const endpoint = app.use(http);
      if (!endpoint.ok) throw new Error("HTTP service unavailable");
      const address = await endpoint.value.address(undefined);
      if (!address.ok) throw new Error("HTTP address unavailable");
      const response = await fetch(new URL("42", address.value));
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ id: "42", name: "小明" });
      const missing = await fetch(new URL("missing", address.value));
      expect(missing.status).toBe(404);
      expect(await missing.json()).toBeNull();
      const unloaded = await app.uninstall(loaded.value.plugins[0]!, { cascade: true });
      expect(unloaded.ok).toBe(true);
      expect(app.inspect()).toMatchObject({ scopes: 1, plugins: [], effects: 0, activeCalls: 0, activeTasks: 0, pendingEvents: 0, serviceLeases: 0 });
      expect(closed).toEqual(Array.from({ length: round + 1 }, () => ["http", "database"]).flat());
    }
    expect(opened).toBe(2);
  } finally {
    const disposed = await app.close();
    expect(disposed.ok).toBe(true);
  }
});
