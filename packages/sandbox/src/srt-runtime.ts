import { SandboxManager } from "@anthropic-ai/sandbox-runtime";

export interface SrtFilesystem {
  readonly denyRead: readonly string[];
  readonly allowWrite: readonly string[];
  readonly denyWrite: readonly string[];
}

export interface SrtWrapRequest {
  readonly command: string;
  readonly fs: SrtFilesystem;
  readonly cwd: string | undefined;
  readonly commandId: string;
}

export interface SrtRuntime {
  checkDeps(): Promise<readonly string[]>;
  start(fs: SrtFilesystem, allowLocalBinding: boolean): Promise<void>;
  syncNetwork(allowedDomains: readonly string[]): void;
  wrap(req: SrtWrapRequest): Promise<readonly string[]>;
  reset(): Promise<void>;
}

const filesystemOf = (fs: SrtFilesystem) => ({
  denyRead: [...fs.denyRead],
  allowWrite: [...fs.allowWrite],
  denyWrite: [...fs.denyWrite],
});

export function platformDepErrors(
  platform: string,
  which: (command: string) => string | null,
): readonly string[] {
  if (platform === "darwin") return which("sandbox-exec") === null ? ["sandbox-exec not found in PATH"] : [];
  if (platform !== "linux") return [`unsupported platform: ${platform}`];
  return [];
}

export const realSrtRuntime: SrtRuntime = {
  checkDeps: async () => {
    const own = platformDepErrors(process.platform, (command) => Bun.which(command));
    if (own.length > 0 || process.platform !== "linux") return own;
    return (await SandboxManager.checkDependenciesAsync()).errors;
  },
  start: async (fs, allowLocalBinding) => {
    await SandboxManager.initialize({
      filesystem: filesystemOf(fs),
      network: { allowedDomains: [], deniedDomains: [], strictAllowlist: true, allowLocalBinding },
    });
  },
  syncNetwork: (allowedDomains) => {
    const config = SandboxManager.getConfig();
    if (config === undefined) return;
    SandboxManager.updateConfig({
      ...config,
      network: { ...config.network, allowedDomains: [...allowedDomains] },
    });
  },
  wrap: async ({ command, fs, cwd, commandId }) => {
    const { argv } = await SandboxManager.wrapWithSandboxArgv(
      command,
      "/bin/bash",
      { filesystem: filesystemOf(fs) },
      undefined,
      cwd,
      { commandId },
    );
    return argv;
  },
  reset: () => SandboxManager.reset(),
};
