// 凭据存储（DESIGN §3.6）：<agentDir>/credentials.json（0600，仅 API key）；
// key 只从 stdin 进、全路径零回显——错误消息经 replaceAll(key,"[redacted]") 兜底
// 脱敏；写链串行（read-modify-write）；坏文件降级空表（首跑常态）。apiKey 解析
// 序 = credentials > providers.json 字面 > apiKeyEnv（快照构造在 catalog 单点）。
import { chmod, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export interface Credentials {
  /** provider → API key（永不出现在任何输出帧） */
  keys: Record<string, string>;
}

export function createCredentials(agentDir: string) {
  const path = join(agentDir, "credentials.json");
  let writeChain: Promise<void> = Promise.resolve();
  const tmpPath = (): string => join(agentDir, `credentials.${process.pid}.${randomUUID().slice(0, 8)}.tmp`);

  async function read(): Promise<Credentials> {
    try {
      const raw = await readFile(path, "utf8");
      const parsed = JSON.parse(raw) as { keys?: unknown };
      if (parsed !== null && typeof parsed === "object" && typeof parsed.keys === "object" && parsed.keys !== null) {
        const keys: Record<string, string> = {};
        for (const [provider, value] of Object.entries(parsed.keys as Record<string, unknown>)) {
          if (typeof value === "string") keys[provider] = value;
        }
        return { keys };
      }
      return { keys: {} };
    } catch {
      return { keys: {} }; // 缺席（首跑）/坏文件：空表降级
    }
  }

  /** 串行写链（read-modify-write）：失败在 catch 内复位链（不毒化后续写） */
  async function enqueueWrite(op: () => Promise<void>): Promise<void> {
    try {
      await (writeChain = writeChain.then(op));
    } catch (error) {
      writeChain = Promise.resolve();
      throw error;
    }
  }

  async function persist(provider: string, mutate: (keys: Record<string, string>) => void): Promise<void> {
    await enqueueWrite(async () => {
      const creds = await read();
      mutate(creds.keys);
      const tmp = tmpPath();
      await writeFile(tmp, JSON.stringify({ keys: creds.keys }, null, 2), "utf8");
      await chmod(tmp, 0o600);
      await rename(tmp, path);
    });
  }

  return {
    read,
    setKey(provider: string, apiKey: string): Promise<void> {
      return persist(provider, (keys) => {
        keys[provider] = apiKey;
      });
    },
    removeKey(provider: string): Promise<void> {
      return persist(provider, (keys) => {
        delete keys[provider];
      });
    },
  };
}

export type CredentialStore = ReturnType<typeof createCredentials>;

/** 错误消息脱敏兜底：任何含 key 本体的字符串先替换再外发 */
export function redact(text: string, secrets: string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret !== "") out = out.replaceAll(secret, "[redacted]");
  }
  return out;
}
