// srt 运行时缝（docs/SANDBOX.md §3）：@anthropic-ai/sandbox-runtime 模块级单例的薄封装——
// 生产唯一实现 + 测试假体注入位。文件面 per-exec 全量传入（srt 语义 per-call 字段级 ?? 回退——
// 传全量防会话级残值混入）；网络面进程级 strict 白名单、无 ask 回调（用户裁决②：交互归
// permission/宿主）。单例占用纪律（claim/release）在 plugin.ts，不在本层。

import { SandboxManager } from "@anthropic-ai/sandbox-runtime";

/** 文件面围栏（Fence → srt FilesystemConfig 的同形投影） */
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
  /** 依赖探测（darwin=seatbelt / linux=bwrap）；返回错误清单，空=可用 */
  checkDeps(): Promise<readonly string[]>;
  /** 以基线剖面启动（网络恒 strict 空白名单——围栏恒在；授权域名经 syncNetwork 热切换注入） */
  start(fs: SrtFilesystem): Promise<void>;
  /** 网络白名单热切换（srt 每请求生效——在跑子进程下一次连接即见新表） */
  syncNetwork(allowedDomains: readonly string[]): void;
  /** 命令文本 → 围栏 argv（外层 /bin/bash -c 承载） */
  wrap(req: SrtWrapRequest): Promise<readonly string[]>;
  /** 全量释放（停代理/清理挂载点） */
  reset(): Promise<void>;
}

const filesystemOf = (fs: SrtFilesystem) => ({
  denyRead: [...fs.denyRead],
  allowWrite: [...fs.allowWrite],
  denyWrite: [...fs.denyWrite],
});

/** 平台依赖自探（纯函数表驱动）：darwin 查 sandbox-exec（srt 的 darwin 分支什么都不查）；
 *  非 POSIX 目标直接不可用；linux 的 bwrap/rg/socat 检查归 srt（调用方委托）。 */
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
  start: async (fs) => {
    await SandboxManager.initialize({
      filesystem: filesystemOf(fs),
      network: { allowedDomains: [], deniedDomains: [], strictAllowlist: true },
    });
  },
  syncNetwork: (allowedDomains) => {
    const config = SandboxManager.getConfig();
    if (config === undefined) return; // 未启动——生命周期由 plugin claim/release 保证
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
