// 契约模块：宿主与插件共享的服务 token（同一模块实例——同一 token 对象）。
import { defineService } from "@x-harness/core";

/** 宿主提供的 sqlite 执行面（连接归宿主，插件只拿到执行器） */
export interface SqliteDb {
  run(sql: string, ...params: (string | number | null)[]): void;
  all<T>(sql: string, ...params: (string | number | null)[]): T[];
}

export const crudDb = defineService<SqliteDb>("crud-db");

export interface Item {
  id: number;
  name: string;
}
