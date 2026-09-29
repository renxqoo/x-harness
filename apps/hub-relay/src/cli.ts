import { parseArgs } from "node:util";
import process from "node:process";
import { startRelay } from "./main.ts";

const { values } = parseArgs({
  options: {
    port: { type: "string" },
    host: { type: "string" },
    "single-instance": { type: "boolean" },
    "redis-host": { type: "string" },
    "redis-port": { type: "string" },
    "redis-password": { type: "string" },
  },
});
const tokenSecret = process.env.RELAY_TOKEN_SECRET;
if (tokenSecret === undefined || tokenSecret.length < 32) {
  process.stderr.write("RELAY_TOKEN_SECRET required (>= 32 chars)\n");
  process.exit(2);
}
const port = values.port !== undefined ? Number.parseInt(values.port, 10) : Number.NaN;
if (!Number.isFinite(port)) {
  process.stderr.write("--port <number> required\n");
  process.exit(2);
}
const relay = await startRelay({
  port,
  host: values.host ?? "0.0.0.0",
  tokenSecret,
  singleInstance: values["single-instance"] === true,
  ...(values["redis-host"] !== undefined
    ? {
        redis: {
          host: values["redis-host"],
          port: values["redis-port"] !== undefined ? Number.parseInt(values["redis-port"], 10) : 6379,
          ...(values["redis-password"] !== undefined ? { password: values["redis-password"] } : {}),
        },
      }
    : {}),

});
const address = relay.server.address() as { port: number };
process.stdout.write(`relay listening on ${address.port}\n`);
process.on("SIGTERM", () => {
  void relay.close().then(() => process.exit(0));
});
process.on("SIGINT", () => {
  void relay.close().then(() => process.exit(0));
});
