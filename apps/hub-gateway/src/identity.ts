// gateway 长期身份（DESIGN §0 三钥模型）：Ed25519 签名 + X25519 加密静态钥。
// 首启生成；之后每次启动校验文件可读并加载。installationId 同文件组生成。
import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { generateBoxKeyPair, generateSigningKeyPair, x25519PublicFromSecret } from "@x-harness/remote-protocol";
import { join } from "node:path";

export interface GatewayIdentity {
  installationId: string;
  signingSecret: string;
  signingPub: string;
  boxSecret: string;
  boxPub: string;
}

export async function loadOrCreateIdentity(paths: { agentDir: string; installationIdFile: string; gatewayIdentityFile: string }): Promise<GatewayIdentity> {
  await mkdir(paths.agentDir, { recursive: true });
  let installationId: string | null = null;
  try {
    installationId = (await readFile(paths.installationIdFile, "utf8")).trim();
    if (installationId.length === 0) installationId = null;
  } catch {
    installationId = null;
  }
  if (installationId === null) {
    installationId = randomUUID();
    await atomicWrite(paths.installationIdFile, installationId);
  }
  let identity: GatewayIdentity | null = null;
  try {
    const raw = JSON.parse(await readFile(paths.gatewayIdentityFile, "utf8")) as Partial<GatewayIdentity>;
    if (typeof raw.installationId === "string" && typeof raw.signingSecret === "string" && typeof raw.boxSecret === "string") {
      identity = {
        installationId: raw.installationId,
        signingSecret: raw.signingSecret,
        signingPub: raw.signingPub ?? "",
        boxSecret: raw.boxSecret,
        boxPub: raw.boxPub ?? x25519PublicFromSecret(raw.boxSecret),
      };
    }
  } catch {
    identity = null;
  }
  if (identity === null) {
    const signing = generateSigningKeyPair();
    const box = generateBoxKeyPair();
    identity = { installationId, signingSecret: signing.secret, signingPub: signing.pub, boxSecret: box.secret, boxPub: box.pub };
    await atomicWrite(paths.gatewayIdentityFile, JSON.stringify(identity, null, 2));
  }
  if (identity.installationId !== installationId) {
    // 身份组撕裂（手工改文件）：以 installationId 文件为准重建身份
    const signing = generateSigningKeyPair();
    const box = generateBoxKeyPair();
    identity = { installationId, signingSecret: signing.secret, signingPub: signing.pub, boxSecret: box.secret, boxPub: box.pub };
    await atomicWrite(paths.gatewayIdentityFile, JSON.stringify(identity, null, 2));
  }
  return identity;
}

export async function atomicWrite(path: string, contents: string): Promise<void> {
  const tmp = join(path, "..", `.tmp-${randomUUID()}`);
  const { writeFile, chmod, rename } = await import("node:fs/promises");
  await writeFile(tmp, contents, { encoding: "utf8" });
  await chmod(tmp, 0o600);
  await rename(tmp, path);
}

export function installationAddress(identity: GatewayIdentity): string {
  return `gw_${identity.installationId}`;
}
