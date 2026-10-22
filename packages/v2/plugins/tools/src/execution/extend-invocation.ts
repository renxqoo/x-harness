import type { Invocation } from "../../../../core/src/index";

export function extendInvocation<I extends Invocation, E extends object>(
  call: I,
  extension: E,
): Readonly<I & E> {
  return Object.freeze(
    Object.defineProperties(
      {},
      {
        ...Object.getOwnPropertyDescriptors(call),
        ...Object.getOwnPropertyDescriptors(extension),
      },
    ),
  ) as Readonly<I & E>;
}
