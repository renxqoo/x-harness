const SIGNATURES: readonly RegExp[] = [
  /Operation not permitted/i,
  /Permission denied/i,
  /EPERM/i,
  /EACCES/i,
  /sandbox/i,
  /deny.*(?:read|write)/i,
];

export function fenceSuspectOf(exitCode: number | null, stderr: string): boolean {
  if (exitCode === null || exitCode === 0) return false;
  return SIGNATURES.some((signature) => signature.test(stderr));
}
