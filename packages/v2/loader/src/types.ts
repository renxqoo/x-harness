import type {
  Application,
  ApplicationOptions,
  ApplicationSnapshot,
} from "../../application/src/index";
import type { Result } from "../../core/src/index";

export interface SharedModule {
  readonly path: string;
  readonly directory: string;
}
export interface LoaderOptions {
  readonly entries: readonly string[];
  readonly shared?: Readonly<Record<string, SharedModule>>;
  readonly watch?: boolean;
  readonly debounceMs?: number;
  readonly maxImports?: number;
  readonly importTimeoutMs?: number;
  readonly application?: ApplicationOptions;
}
export type LoaderPhase = "sdk" | "shared" | "watch" | "build" | "import" | "validate" | "close";
export interface LoaderFault {
  readonly source: "loader";
  readonly code:
    | "invalid-input"
    | "build-failed"
    | "import-failed"
    | "invalid-plugin"
    | "restart-required"
    | "watch-failed"
    | "closed";
  readonly message: string;
  readonly phase?: LoaderPhase;
  readonly entryIndex?: number;
}
export interface LoaderStatus {
  readonly state: "open" | "closed" | "restart-required";
  readonly imports: number;
  readonly maxImports: number;
  readonly error?: LoaderFault;
}
export interface Loader {
  reload(): Promise<Result<ApplicationSnapshot, LoaderFault>>;
  status(): LoaderStatus;
  snapshot: Application["snapshot"];
  use: Application["use"];
  dispatch: Application["dispatch"];
  inspect: Application["inspect"];
  close: Application["close"];
}
export interface LoaderConfig {
  readonly entries: readonly string[];
  readonly shared: ReadonlyMap<string, SharedModule>;
  readonly watch: boolean;
  readonly debounceMs: number;
  readonly maxImports: number;
  readonly importTimeoutMs: number;
  readonly application?: ApplicationOptions;
}
