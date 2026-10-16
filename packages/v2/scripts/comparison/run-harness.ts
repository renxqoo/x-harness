import type { Journeys } from "./types";
import { readService } from "./harness/read-service";
import { closeResource } from "./harness/close-resource";
import { joinTask } from "./harness/join-task";
import { deliverEvent } from "./harness/deliver-event";
import { replaceProvider } from "./harness/replace-provider";
import { drainReplacement } from "./harness/drain-replacement";

export async function runHarness(): Promise<Journeys> {
  return { service: await readService(), resource: await closeResource(), task: await joinTask(), event: await deliverEvent(), replacement: await replaceProvider(), inFlight: await drainReplacement() };
}
