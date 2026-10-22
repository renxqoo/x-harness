import type { AnyResult } from "../foundation/types";

export interface OutcomeSubscription {
  deliver?: (result: AnyResult | undefined) => void;
}

export function subscribeOutcome(
  outcome: Promise<AnyResult>,
  subscription: OutcomeSubscription,
): void {
  void outcome.then(
    (result) => subscription.deliver?.(result),
    () => subscription.deliver?.(undefined),
  );
}
