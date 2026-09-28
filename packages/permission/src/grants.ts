// 会话授权集（docs/EXEC-ENV.md §5）：extraRoots/会话规则——按会话键控（A 会话批的
// 根 B 会话不借用；resume 不继承）；sessionDisposed 逐出。域名正负缓存面已删（2026-09-28
// P3-8：网络声明位删除后生产零消费——死机制面不养）。
// 例外口径：unrestricted 是**进程级**总括授权（full 档装配期确立，docs/PERMISSION-FULL-
// UNRESTRICTED.md）——对无 rootOverride 的会话 extraRootsOf 表现为全盘根 "/"（吸收一切
// 逐目录授权）；rootOverride（worktree 隔离）会话例外：不注入总括根、逐目录授权原语义保留，
// isUnrestricted 对其恒 false（文件面与网络面例外同向——防总括打穿件13 隔离）。

import { resolve } from "node:path";
import type { SessionId } from "@x-harness/session";
import type { PermissionRule } from "./types.ts";

interface SessionBucket {
  extraRoots: Set<string>;
  rules: PermissionRule[];
  /** 会话级根替换（worktree 隔离——件13 接缝 3）：dir=替换根；guard=原根（extraRoots 守卫） */
  rootOverride?: { readonly dir: string; readonly guard: string };
}

export class GrantsRegistry {
  private readonly buckets = new Map<string, SessionBucket>();
  /** override 会话键的进程级记忆（evict 不清）——防 worktree 会话逐出后总括根复活打穿隔离 */
  private readonly overriddenKeys = new Set<string>();
  /** 已逐出会话（红队 F5）：迟到 allow+memory 不得复活授权桶——写入口全 fail-closed */
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

  /** 进程级 override 事实：桶被 evict 后仍成立——总括例外的判定不随会话终结失效 */
  private isOverridden(session: SessionId | undefined): boolean {
    return this.overriddenKeys.has(session ?? "_anon");
  }

  /** 进程级总括授权（full 档）。可重复置位/撤销（运行期切档同步授权面——permissionMode
   *  服务消费）；撤销即时收回一切在飞会话的总括授权（逐目录/规则授权面不受影响）。 */
  setUnrestricted(enabled: boolean): void {
    this.unrestricted = enabled;
  }

  /** 总括态查询：override 会话恒 false（隔离压过总括，文件/网络两面同向）；
   *  seal 后恒 false（拆卸收回——fail-closed）。 */
  isUnrestricted(session: SessionId | undefined): boolean {
    if (!this.unrestricted || this.disposed) return false;
    return !this.isOverridden(session);
  }

  extraRootsOf(session: SessionId | undefined): readonly string[] {
    // 总括贡献与逐目录授权分立：无 override 会话深等于 ["/"]（吸收，非并集）；
    // override 会话不注入总括根——其自身路径的 ask→批准→读回链依赖逐目录语义
    if (this.unrestricted && !this.disposed && !this.isOverridden(session)) {
      return ["/"];
    }
    const bucket = this.buckets.get(session ?? "_anon");
    return bucket === undefined ? [] : [...bucket.extraRoots];
  }

  addExtraRoot(session: SessionId | undefined, dir: string): void {
    if (this.disposed || this.deadSessions.has(session ?? "_anon")) return; // seal/已逐出会话 fail-closed
    this.bucket(session).extraRoots.add(dir);
  }

  /** 会话根替换（worktree 子的真隔离）：dir 替换主根；guard=原根——该根子树的 extraRoot
   *  批准在消费面被过滤（防权限批准打穿隔离——件13 §8.2）。resume 不继承，复活方重放。 */
  setRootOverride(session: SessionId | undefined, dir: string, guard: string): void {
    this.overriddenKeys.add(session ?? "_anon"); // 进程级记忆：evict 逐出桶后总括例外仍成立
    this.bucket(session).rootOverride = { dir: resolve(dir), guard: resolve(guard) };
  }

  rootOverrideOf(session: SessionId | undefined): { readonly dir: string; readonly guard: string } | undefined {
    return this.buckets.get(session ?? "_anon")?.rootOverride;
  }

  rulesOf(session: SessionId | undefined): readonly PermissionRule[] {
    return this.buckets.get(session ?? "_anon")?.rules ?? [];
  }

  /** 会话习得规则写入（origin=session——grant 记忆桶；evict 即焚，resume/fork 不复活） */
  addRule(session: SessionId | undefined, rule: PermissionRule): void {
    if (this.disposed || this.deadSessions.has(session ?? "_anon")) return; // fail-closed：seal 后/已逐出会话拒新记录
    const bucket = this.bucket(session);
    if (!bucket.rules.some((existing) => existing.tool === rule.tool && existing.pattern === rule.pattern)) {
      bucket.rules.push(rule);
    }
  }

  evict(session: SessionId | undefined): void {
    const key = session ?? "_anon";
    this.buckets.delete(key);
    this.deadSessions.add(key); // 迟到裁决写入口全灭（红队 F5）
  }

  /** 拆卸契约（§5）：拒新记录；在飞 ask 的 broker 迟到裁决被丢弃（deny 结算语义） */
  seal(): void {
    this.disposed = true;
  }
}
