import { defineService } from "../../../index";
import type {
  BusinessFailure,
  ChainHandler,
  CoreFault,
  Disposer,
  MethodSpec,
  Result,
  SameSignature,
  Validator,
} from "../../../index";

type Assert<T extends true> = T;
type DomainError = { code: "timeout"; message: string; domain: string };
export type PreservedBusiness = Assert<
  SameSignature<BusinessFailure<Result<number, DomainError>>, DomainError>
>;
export type WithoutBusiness = Assert<SameSignature<BusinessFailure<Result<number>>, never>>;
export const returnedNext: ChainHandler<string, number> = (input, next) => next(input);
export const voidMethod = defineService<{ open(input: void): Promise<Result<Disposer>> }>({
  name: "void",
  methods: { open: {} },
});
export const errorValidator: Validator<DomainError> = (input) => ({
  ok: true,
  value: input as DomainError,
});
export const specification: MethodSpec<(input: string) => Promise<Result<number, DomainError>>> = {
  failure: errorValidator,
};
export const fault: CoreFault = { source: "core", code: "timeout", message: "timeout" };
