import type { Result } from "../../core/src/index";

export interface Endpoint {
  read(input: string): Promise<Result<string>>;
}
export interface Journeys {
  service: string;
  resource: { opened: number; closed: number };
  task: { finished: number; cancelled: boolean; closeWaited: boolean };
  event: string[];
  replacement: {
    before: string;
    after: string;
    starts: number;
    cleanup: string[];
    savedEntry: string;
  };
  inFlight: {
    closedBeforeGate: boolean;
    replacementSettledBeforeGate: boolean;
    bodySawClosed: boolean;
    savedEntryBlocked: boolean;
    next: string;
  };
}
