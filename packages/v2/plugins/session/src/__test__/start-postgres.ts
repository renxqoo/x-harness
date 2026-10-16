import { resolve } from "node:path";
import type { TestProject } from "vitest/node";
import { command, startCluster } from "./postgres-cluster";

declare module "vitest" { export interface ProvidedContext { sessionPostgresUrl: string } }
export default async function startPostgres(context: TestProject) {
  await command([process.execPath, resolve(context.config.root, "scripts/build.ts")]);
  const supplied = process.env.SESSION_TEST_POSTGRES_URL;
  if (supplied) { context.provide("sessionPostgresUrl", supplied); return; }
  const cluster = await startCluster(); context.provide("sessionPostgresUrl", cluster.url); return () => cluster.close();
}
