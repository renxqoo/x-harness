import type { ResolvedOptions } from "../read-options";
import type { SessionStorage } from "../storage";

export interface Repository { readonly options: ResolvedOptions; readonly storage: SessionStorage }
