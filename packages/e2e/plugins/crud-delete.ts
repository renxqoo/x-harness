// 删：按 id 删除。
import type { Plugin } from "@x-harness/core";
import { defineService } from "@x-harness/core";
import { crudDb } from "./contracts.ts";

export const deleteItem = defineService<{ remove(id: number): void }>("crud-delete");

export default {
  name: "crud-delete",
  apply: (c) => {
    const db = c.use(crudDb);
    c.provide(deleteItem, {
      remove: (id) => db.run("DELETE FROM items WHERE id = ?", id),
    });
  },
} satisfies Plugin;
