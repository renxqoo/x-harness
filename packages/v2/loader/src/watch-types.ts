import type { Result } from "../../core/src/index";
import type { LoaderFault } from "./types";
export interface WatchTarget {
  readonly path: string;
  readonly identity: string;
  readonly recursive: boolean;
}
export interface WatchCallbacks {
  changed(this: void): void;
  failed(this: void): void;
}
export type OpenDirectoryWatch = (target: WatchTarget, callbacks: WatchCallbacks) => Result<() => void, LoaderFault>;
