// 改：按 id 改名。
import type { Plugin } from "@x-harness/core";
import { defineService } from "@x-harness/core";
import { crudDb } from "./contracts.ts";

export const updateItem = defineService<{ rename(id: number, name: string): void }>("crud-update");

export default {
  name: "crud-update",
  apply: (c) => {
    const db = c.use(crudDb);
    c.provide(updateItem, {
      rename: (id, name) => db.run("UPDATE items SET name = ? WHERE id = ?", name, id),
    });
  },
} satisfies Plugin;
