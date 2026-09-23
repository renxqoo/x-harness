// fenceSuspect 归因单点（docs/PERMISSION-V2-DESIGN.md U14）：contained 执行失败后，
// 由本函数判定「形态像围栏打挂」——on-failure 升级流的触发器。归因含文本启发成分
// （运行期 EPERM 对 harness 只是子进程 stderr 文本），残余伪造面已在设计申报：
// 升级弹窗必须展示失败原文与完整命令，用户是最终裁判；调用方（tool-bash）据此限频。

/** 围栏拒绝签名：内核 deny 面（macOS seatbelt / linux landlock 常见文本） */
const SIGNATURES: readonly RegExp[] = [
  /Operation not permitted/i,
  /Permission denied/i,
  /EPERM/i,
  /EACCES/i,
  /sandbox/i,
  /deny.*(?:read|write)/i,
];

/** 失败归因：非零退出 + stderr 命中签名（超时/信号死亡不算——那是命令自身问题形态） */
export function fenceSuspectOf(exitCode: number | null, stderr: string): boolean {
  if (exitCode === null || exitCode === 0) return false;
  return SIGNATURES.some((signature) => signature.test(stderr));
}
