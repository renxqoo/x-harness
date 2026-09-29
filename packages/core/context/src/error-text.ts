export function errorText(error: unknown): string {
  if (error instanceof AggregateError) return error.errors.map((inner) => errorText(inner)).join("; ");
  if (error instanceof Error) {
    try {
      return error.message;
    } catch {
      return "<unprintable thrown value>";
    }
  }
  try {
    return String(error);
  } catch {
    return "<unprintable thrown value>";
  }
}
