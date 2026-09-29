import { defineService } from "@x-harness/core";

export interface SqliteDb {
  run(sql: string, ...params: (string | number | null)[]): void;
  all<T>(sql: string, ...params: (string | number | null)[]): T[];
}

export const crudDb = defineService<SqliteDb>("crud-db");

export interface Item {
  id: number;
  name: string;
}
