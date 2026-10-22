import type { CreateProjectOptions, CreateProjectResult } from "./types";
import { readProjectOptions } from "./read-project-options";
import { renderProject } from "./render-project";
import { writeProject } from "./write-project";

export async function createProject(options: CreateProjectOptions): Promise<CreateProjectResult> {
  const config = await readProjectOptions(options);

  if (!config.ok) return config;

  return writeProject(config.value.directory, renderProject(config.value));
}
