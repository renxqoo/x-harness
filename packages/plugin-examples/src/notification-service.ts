// ⑮ 能力插件：通知服务（defineService + provide——其他插件可消费的标准 seam 形态）。
// 真实场景：多个插件需要统一的用户通知面（审计/预算/循环检测都想发通知）。

import type { Disposer, Plugin } from "@x-harness/core";
import type { Context } from "@x-harness/core";
import { defineService } from "@x-harness/core";

export interface Notification {
  readonly level: "info" | "warn" | "error";
  readonly source: string;
  readonly message: string;
}

export interface NotificationService {
  notify(n: Notification): void;
  recent(): readonly Notification[];
}

export const notificationService = defineService<NotificationService>("notification-service");

export function notificationPlugin(): Plugin {
  return {
    name: "notification",
    apply: (ctx: Context): Disposer => {
      const log: Notification[] = [];
      return ctx.provide(notificationService, {
        notify: (n) => {
          log.push(n);
          if (log.length > 100) log.shift(); // 环形缓冲
        },
        recent: () => [...log],
      });
    },
  };
}
