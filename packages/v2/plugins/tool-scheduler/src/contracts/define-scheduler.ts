import { defineGuard, defineService } from "../../../../core/src/index";
import { createFault } from "../../../../core/src/validation";
import { readToolOutput } from "../../../tools/src/validation";
import type { ToolSchedulerService, ScheduleAccess } from "./types";
import { readAccess } from "../domain/read-access";
import { readFailure } from "../domain/read-failure";
import { readReport } from "../domain/read-report";
import { data, keys, integer } from "../domain/read-values";
const service = defineService<ToolSchedulerService>({
  name: "tool-scheduler",
  methods: {
    execute: {
      failure: readFailure,
      output(raw) {
        const output = readToolOutput(raw, 4194304);
        return output.ok ? output : createFault("invalid-result");
      },
    },
    batch: { failure: readFailure, output: readReport },
    inspect: {
      failure: readFailure,
      output(raw) {
        const d = data(raw);

        if (
          !d ||
          !keys(d, ["running", "queued", "requests"]) ||
          !integer(d.running, 0, 128) ||
          !integer(d.queued, 0, 1024) ||
          !integer(d.requests, 0, 128)
        )
          return createFault("invalid-result");

        return {
          ok: true,
          value: Object.freeze({ running: d.running, queued: d.queued, requests: d.requests }),
        };
      },
    },
  },
});

if (!service.ok) throw new Error("Invalid scheduler definition");

export const toolScheduler = service.value;
const guard = defineGuard<ScheduleAccess>({ name: "tool-scheduler/access", input: readAccess });

if (!guard.ok) throw new Error("Invalid scheduler access definition");

export const toolScheduleAccess = guard.value;
