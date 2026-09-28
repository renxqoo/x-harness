// @x-harness/remote-client 导出面（参考客户端：e2e 驱动 + App 端参考实现）
export { connectRemote } from "./connect.ts";
export type { RemoteClientHandle, RemoteClientOptions, RemoteCodec } from "./connect.ts";
export { createRatchetCodec } from "./ratchet-store.ts";
export type { RatchetCodecDeps } from "./ratchet-store.ts";
