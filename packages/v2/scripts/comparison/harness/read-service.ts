import { createHost, definePlugin, defineService } from "../../../core/src/index";
import type { Endpoint } from "../types";
import { unwrap } from "../unwrap";

export async function readService() {
  const source = unwrap(defineService<Endpoint>({ name: "journey/source", methods: { read: {} } }));
  const target = unwrap(defineService<Endpoint>({ name: "journey/target", methods: { read: {} } }));
  const host = unwrap(createHost());
  try {
    unwrap(await host.install([
      definePlugin({ name: "source", provides: { source }, setup(ctx) { return ctx.service({ source: { async read(input) { return { ok: true, value: `hello:${input}` }; } } }); } }),
      definePlugin({ name: "target", requires: { source }, provides: { target }, setup(ctx) { return ctx.service({ target: { async read(input, call) { return call.deps.source.read(input); } } }); } }),
    ]));
    return unwrap(await unwrap(host.use(target)).read("world"));
  } finally { unwrap(await host.close()); }
}
