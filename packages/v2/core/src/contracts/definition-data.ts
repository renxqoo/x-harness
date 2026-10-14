import type { DefinitionRef, Validator } from "./types";

export interface MethodData {
  readonly input?: Validator<unknown>;
  readonly output?: Validator<unknown>;
  readonly failure?: Validator<unknown>;
}

export interface DefinitionData extends MethodData {
  readonly token: DefinitionRef;
  readonly methods: Readonly<Record<string, MethodData>>;
}

export const definitionData = new WeakMap<DefinitionRef, DefinitionData>();
