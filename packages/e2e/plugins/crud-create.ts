// 增：插入一条记录。
import type { Plugin } from "@x-harness/core";
import { defineService } from "@x-harness/core";
import { crudDb } from "./contracts.ts";

export const createItem = defineService<{ insert(name: string): void }>("crud-create");

export default {
  name: "crud-create",
  apply: (c) => {
    const db = c.use(crudDb);
    c.provide(createItem, {
      insert: (name) => db.run("INSERT INTO items (name) VALUES (?)", name),
    });
  },
} satisfies Plugin;
