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
  askDomainOnce(session: SessionId | undefined, domain: string, ask: () => Promise<"allow" | "deny">): Promise<"allow" | "deny"> {
    const settled = this.domainVerdict(session, domain);
    if (settled !== undefined) return Promise.resolve(settled);
    const key = `${session ?? "_anon"}\u0000${domain}`;
    // 链条只由本方法写入（永不 reject 的续接）——单臂足够
    const previous: Promise<unknown> = this.domainChains.get(key) ?? Promise.resolve();
    const run = previous.then(() => this.settleDomainAsk(session, domain, ask));
    this.domainChains.set(
      key,
      run.then(
        () => {},
        () => {},
      ),
    );
    return run;
  }

  private async settleDomainAsk(session: SessionId | undefined, domain: string, ask: () => Promise<"allow" | "deny">): Promise<"allow" | "deny"> {
    const settled = this.domainVerdict(session, domain); // 链上排队后复检（前一个 ask 可能已记）
    if (settled !== undefined) return settled;
    let verdict: "allow" | "deny";
    try {
      verdict = await ask();
    } catch {
      verdict = "deny"; // broker 抛错 fail-closed
    }
    if (this.disposed) return "deny"; // 拆卸后迟到裁决丢弃——deny 结算
    this.recordDomain(session, domain, verdict);
    return verdict;
  }

  evict(session: SessionId | undefined): void {
    this.buckets.delete(session ?? "_anon");
  }

  /** 拆卸契约（§5）：拒新记录；在飞 ask 的 broker 迟到裁决被丢弃（deny 结算语义） */
  seal(): void {
    this.disposed = true;
  }
}
