import Ajv from "ajv";
import type { ValidateFunction } from "ajv";
import type { ToolInputSchema, ToolsResult } from "../contracts/types";
import { readSchema } from "./read-schema";
import { fail } from "../domain/fail";
export const maximumSchemaCodeBytes = 262144;

export function compileSchema(
  raw: unknown,
): ToolsResult<{ readonly schema: ToolInputSchema; readonly validate: ValidateFunction }> {
  const parsed = readSchema(raw);

  if (!parsed.ok) return parsed;

  try {
    const ajv = new Ajv({
      strict: true,
      allErrors: false,
      ownProperties: true,
      addUsedSchema: false,
      code: { optimize: 1 },
    });
    const validate = ajv.compile(parsed.value);

    if (new TextEncoder().encode(validate.toString()).length > maximumSchemaCodeBytes)
      return fail("capacity-exceeded");

    return { ok: true, value: { schema: parsed.value as ToolInputSchema, validate } };
  } catch {
    return fail("invalid-schema");
  }
}
