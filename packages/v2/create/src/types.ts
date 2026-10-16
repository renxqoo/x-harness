import type { Result } from "../../core/src/index";
export interface CreateProjectOptions { readonly directory: string; readonly name: string; readonly sdk?: string }
export interface CreateProjectReport { readonly directory: string; readonly files: readonly string[] }
export interface CreateProjectFault { readonly source: "create"; readonly code: "invalid-input" | "target-exists" | "write-failed"; readonly message: string; readonly directory?: string }
export type CreateProjectResult = Result<CreateProjectReport, CreateProjectFault>;
export interface ProjectConfig { readonly directory: string; readonly name: string; readonly sdk: string; readonly compiler: string; readonly types: string }
