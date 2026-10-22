import { resolve } from "node:path";
import { createProject } from "./create-project";

export async function runCreate(args: readonly string[]): Promise<number> {
  if (args.length < 2 || args.length > 3 || args.some((arg) => arg.startsWith("-"))) {
    process.stderr.write("Usage: bun create/src/cli.ts <directory> <name> [sdk-directory]\n");
    return 1;
  }

  const result = await createProject({
    directory: resolve(args[0]!),
    name: args[1]!,
    ...(args[2] ? { sdk: resolve(args[2]) } : {}),
  });

  if (!result.ok) {
    process.stderr.write(JSON.stringify(result.error) + "\n");
    return 1;
  }

  process.stdout.write(JSON.stringify(result.value) + "\n");
  return 0;
}

if (import.meta.main) process.exitCode = await runCreate(process.argv.slice(2));
