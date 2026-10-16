import { parentPort, workerData } from "node:worker_threads";
import { serveSqlite } from "./serve-sqlite";

serveSqlite(parentPort!, workerData);
