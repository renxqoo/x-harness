import { resolve } from "node:path";
import type { SessionId } from "@x-harness/session";
import type { PermissionRule } from "./types.ts";

interface SessionBucket {
  extraRoots: Set<string>;
  rules: PermissionRule[];
  rootOverride?: { readonly dir: string; readonly guard: string };
}

export class GrantsRegistry {
  private readonly buckets = new Map<string, SessionBucket>();
  private readonly overriddenKeys = new Set<string>();
  private readonly deadSessions = new Set<string>();
  private disposed = false;
  private unrestricted = false;

  private bucket(session: SessionId | undefined): SessionBucket {
    const key = session ?? "_anon";
    const existing = this.buckets.get(key);
    if (existing !== undefined) return existing;
    const fresh: SessionBucket = { extraRoots: new Set(), rules: [] };
    this.buckets.set(key, fresh);
    return fresh;
  }

  private isOverridden(session: SessionId | undefined): boolean {
    return this.overriddenKeys.has(session ?? "_anon");
  }

  setUnrestricted(enabled: boolean): void {
    this.unrestricted = enabled;
  }

  isUnrestricted(session: SessionId | undefined): boolean {
    if (!this.unrestricted || this.disposed) return false;
    return !this.isOverridden(session);
  }

  extraRootsOf(session: SessionId | undefined): readonly string[] {
    if (this.unrestricted && !this.disposed && !this.isOverridden(session)) {
      return ["/"];
    }
    const bucket = this.buckets.get(session ?? "_anon");
    return bucket === undefined ? [] : [...bucket.extraRoots];
  }

  addExtraRoot(session: SessionId | undefined, dir: string): void {
    if (this.disposed || this.deadSessions.has(session ?? "_anon")) return;
    this.bucket(session).extraRoots.add(dir);
  }

  setRootOverride(session: SessionId | undefined, dir: string, guard: string): void {
    this.overriddenKeys.add(session ?? "_anon");
    this.bucket(session).rootOverride = { dir: resolve(dir), guard: resolve(guard) };
  }

  rootOverrideOf(session: SessionId | undefined): { readonly dir: string; readonly guard: string } | undefined {
    return this.buckets.get(session ?? "_anon")?.rootOverride;
  }

  rulesOf(session: SessionId | undefined): readonly PermissionRule[] {
    return this.buckets.get(session ?? "_anon")?.rules ?? [];
  }

  addRule(session: SessionId | undefined, rule: PermissionRule): void {
    if (this.disposed || this.deadSessions.has(session ?? "_anon")) return;
    const bucket = this.bucket(session);
    if (!bucket.rules.some((existing) => existing.tool === rule.tool && existing.pattern === rule.pattern)) {
      bucket.rules.push(rule);
    }
  }

  evict(session: SessionId | undefined): void {
    const key = session ?? "_anon";
    this.buckets.delete(key);
    this.deadSessions.add(key);
  }

  seal(): void {
    this.disposed = true;
  }
}
