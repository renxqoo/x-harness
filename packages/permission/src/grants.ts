// 会话授权集（docs/EXEC-ENV.md §5）：extraRoots/域名正负缓存/会话规则——按会话键控（A 会话批的
// 根/网 B 会话不借用；resume 不继承）；per-(session,domain) 单飞互斥（check→ask→record 临界区——
// 同域并发只问一次，异域并行）；sessionDisposed 逐出。

import type { SessionId } from "@x-harness/session";
import type { PermissionRule } from "./types.ts";

interface SessionBucket {
  extraRoots: Set<string>;
  domains: Map<string, "allow" | "deny">;
  rules: PermissionRule[];
}

function domainChainKey(session: SessionId | undefined, domain: string): string {
  return `${session ?? "_anon"}\u0000${domain}`;
}

export class GrantsRegistry {
  private readonly buckets = new Map<string, SessionBucket>();
  private readonly domainChains = new Map<string, Promise<unknown>>();
  private disposed = false;

  private bucket(session: SessionId | undefined): SessionBucket {
    const key = session ?? "_anon";
    const existing = this.buckets.get(key);
    if (existing !== undefined) return existing;
    const fresh: SessionBucket = { extraRoots: new Set(), domains: new Map(), rules: [] };
    this.buckets.set(key, fresh);
    return fresh;
  }

  extraRootsOf(session: SessionId | undefined): readonly string[] {
    return [...this.bucket(session).extraRoots];
  }

  addExtraRoot(session: SessionId | undefined, dir: string): void {
    this.bucket(session).extraRoots.add(dir);
  }

  domainVerdict(session: SessionId | undefined, domain: string): "allow" | "deny" | undefined {
    return this.bucket(session).domains.get(domain);
  }

  /** 会话已授权域名集合（正缓存；sandbox fence 合成用——deny 不入网络白名单） */
  allowedDomainsOf(session: SessionId | undefined): readonly string[] {
    const out: string[] = [];
    for (const [domain, verdict] of this.bucket(session).domains) {
      if (verdict === "allow") out.push(domain);
    }
    return out;
  }

  recordDomain(session: SessionId | undefined, domain: string, verdict: "allow" | "deny"): void {
    this.bucket(session).domains.set(domain, verdict); // deny=负缓存（重试不重弹）
  }

  rulesOf(session: SessionId | undefined): readonly PermissionRule[] {
    return this.bucket(session).rules;
  }

  /** 域授权单飞：同 (session,domain) 并发只产生一次 ask；异域并行互不阻塞 */
  askDomainOnce(req: {
    readonly session: SessionId | undefined;
    readonly domain: string;
    readonly ask: () => Promise<"allow" | "deny">;
    readonly abort?: Promise<unknown>;
  }): Promise<"allow" | "deny"> {
    const { session, domain, ask, abort } = req;
    const opts = { abort };
    const settled = this.domainVerdict(session, domain);
    if (settled !== undefined) return Promise.resolve(settled);
    const key = domainChainKey(session, domain);
    // 链条只由本方法写入（永不 reject 的续接）——单臂足够
    const previous: Promise<unknown> = this.domainChains.get(key) ?? Promise.resolve();
    const run = previous.then(() => this.settleDomainAsk({ session, domain, ask, abort: opts.abort }));
    this.domainChains.set(
      key,
      run.then(
        () => {},
        () => {},
      ),
    );
    return run;
  }

  private async settleDomainAsk(req: {
    readonly session: SessionId | undefined;
    readonly domain: string;
    readonly ask: () => Promise<"allow" | "deny">;
    readonly abort?: Promise<unknown>;
  }): Promise<"allow" | "deny"> {
    const { session, domain, ask } = req;
    const opts = { abort: req.abort };
    const settled = this.domainVerdict(session, domain); // 链上排队后复检（前一个 ask 可能已记）
    if (settled !== undefined) return settled;
    let verdict: "allow" | "deny";
    try {
      if (opts.abort !== undefined) {
        const outcome = await Promise.race([ask(), opts.abort.then(() => "aborted" as const)]);
        if (outcome === "aborted") return "deny"; // 客户端已断——迟到裁决丢弃（不记账）
        verdict = outcome;
      } else {
        verdict = await ask();
      }
    } catch {
      return "deny"; // broker 抛错 fail-closed（含 race 内 rejected ask）
    }
    if (this.disposed) return "deny"; // 拆卸后迟到裁决丢弃——deny 结算
    this.recordDomain(session, domain, verdict);
    return verdict;
  }

  evict(session: SessionId | undefined): void {
    const key = session ?? "_anon";
    this.buckets.delete(key);
    for (const chainKey of this.domainChains.keys()) {
      if (chainKey.startsWith(`${key}\u0000`)) this.domainChains.delete(chainKey); // 会话链随桶逐出
    }
    void domainChainKey;
  }

  /** 拆卸契约（§5）：拒新记录；在飞 ask 的 broker 迟到裁决被丢弃（deny 结算语义） */
  seal(): void {
    this.disposed = true;
  }
}
