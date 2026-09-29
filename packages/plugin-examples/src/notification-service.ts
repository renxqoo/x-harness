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
          if (log.length > 100) log.shift();
        },
        recent: () => [...log],
      });
    },
  };
}
