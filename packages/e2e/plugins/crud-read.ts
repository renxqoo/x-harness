// 查：列出全部记录。
import type { Plugin } from "@x-harness/core";
import { defineService } from "@x-harness/core";
import { crudDb, type Item } from "./contracts.ts";

export const readItems = defineService<{ all(): Item[] }>("crud-read");

export default {
  name: "crud-read",
  apply: (c) => {
    const db = c.use(crudDb);
    c.provide(readItems, {
      all: () => db.all<Item>("SELECT id, name FROM items ORDER BY id"),
    });
  },
} satisfies Plugin;
