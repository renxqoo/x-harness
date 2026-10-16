import { defineEvent, definePlugin, defineService } from "../../../core/src/index";
import type { JsonValue, Result } from "../../../core/src/index";
import { createFault, readData } from "../../../core/src/validation";
import { validateConfig } from "./validate-config";
import type { ConfigOptions, ConfigPlugin, ConfigReader, ConfigSnapshot, ConfigWriter } from "./types";

export function createConfigPlugin<T extends JsonValue>(input: ConfigOptions<T>): Result<ConfigPlugin<T>> {
  const read = readData(input);
  if (!read.ok || Object.keys(read.value).some((key) => !["name", "initial", "validate"].includes(key)) || typeof read.value.name !== "string" || typeof read.value.validate !== "function") return createFault("invalid-input");
  const options = read.value as unknown as ConfigOptions<T>;
  const initial = validateConfig(options.initial, options.validate);
  if (!initial.ok) return initial;
  const config = defineService<ConfigReader<T>>({ name: `${options.name}/config`, methods: { get: {} } });
  const admin = defineService<ConfigWriter<T>>({ name: `${options.name}/config-admin`, methods: { update: {} } });
  const changed = defineEvent<{ readonly revision: number }>({ name: `${options.name}/config-changed`, payload(input) {
    const read = readData(input);
    if (!read.ok || !Number.isSafeInteger(read.value.revision) || (read.value.revision as number) < 1) return createFault("invalid-input");
    return { ok: true, value: { revision: read.value.revision as number } };
  } });
  if (!config.ok) return config; if (!admin.ok) return admin; if (!changed.ok) return changed;
  const plugin = definePlugin({ name: `${options.name}/config`, provides: { config: config.value, admin: admin.value, changed: changed.value }, setup(ctx) {
    let snapshot: ConfigSnapshot<T> = Object.freeze({ revision: 0, value: initial.value });
    return ctx.service({
      config: { get: () => Promise.resolve({ ok: true, value: snapshot }) },
      admin: { update(input) {
        const next = validateConfig(input, options.validate);
        if (!next.ok) return Promise.resolve(next);
        if (snapshot.revision >= Number.MAX_SAFE_INTEGER) return Promise.resolve(createFault("resource-limit"));
        const revision = snapshot.revision + 1;
        const receipt = ctx.emit("changed", { revision });
        if (!receipt.ok) return Promise.resolve(receipt);
        snapshot = Object.freeze({ revision, value: next.value });
        return Promise.resolve({ ok: true, value: snapshot });
      } },
    });
  } });
  return { ok: true, value: Object.freeze({ plugin, config: config.value, admin: admin.value, changed: changed.value }) };
}
