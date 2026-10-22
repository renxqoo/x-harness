import { readDescription } from "../domain/read-description";
import { readLimits } from "../domain/read-limits";

export function describeContribution(tool: unknown, limits: unknown) {
  const described = readDescription(tool);

  if (!described.ok) return described;

  const configured = readLimits(limits, true);

  if (!configured.ok) return configured;

  const signature = JSON.stringify([described.value, configured.value], (_key, value: unknown) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(
          Object.entries(value).sort(([a], [b]) => {
            if (a < b) return -1;

            return a > b ? 1 : 0;
          }),
        )
      : value,
  );
  return {
    ok: true as const,
    value: { tool: described.value, limits: configured.value, signature },
  };
}
