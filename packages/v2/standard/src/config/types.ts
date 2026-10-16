import type { EventToken, JsonValue, Plugin, Result, ServiceToken, Validator } from "../../../core/src/index";

export interface ConfigSnapshot<T> { readonly revision: number; readonly value: T }
export interface ConfigReader<T> { get(input: void): Promise<Result<ConfigSnapshot<T>>> }
export interface ConfigWriter<T> { update(input: unknown): Promise<Result<ConfigSnapshot<T>>> }
export interface ConfigOptions<T extends JsonValue> { readonly name: string; readonly initial: unknown; readonly validate: Validator<T> }
export interface ConfigPlugin<T extends JsonValue> {
  readonly plugin: Plugin;
  readonly config: ServiceToken<ConfigReader<T>>;
  readonly admin: ServiceToken<ConfigWriter<T>>;
  readonly changed: EventToken<{ readonly revision: number }>;
}
